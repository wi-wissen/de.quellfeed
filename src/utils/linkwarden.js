// Linkwarden sync for the saved articles.
//
// Same contract as src/utils/karakeep.js, and the same warning: this is NOT the two-way
// sync src/utils/sync.js does over WebDAV. There are no tombstones on the other side, the
// server holds the truth, and an article deleted in Quell comes back on the next pull as
// long as the link is still there — deleteFromLinkwarden() is what makes a deletion stick,
// and the store has to call it. A link that vanishes from the server never deletes
// anything locally: absence is not evidence.
//
// ── What Linkwarden cannot carry ────────────────────────────────────────────
// Considerably less than KaraKeep, and the gaps are worth naming up front:
//
//   • NO DATE. `createdAt` is `@default(now())` in the schema and appears in neither the
//     POST nor the PUT body schema. `publishedAt` cannot be uploaded, full stop. A link
//     pulled from Linkwarden therefore carries the day it was IMPORTED, not the day it was
//     published. So the pull never overwrites a publishedAt we already have: a local date
//     is either the feed's real one or the day the user saved the link, and both beat an
//     import date. Only a genuinely new article takes the remote's createdAt, because
//     there is nothing better to take.
//   • NO READ FLAG. The Link model has no such column — only a per-user `pinnedBy`
//     relation. `isRead` is not synced with Linkwarden at all, in either direction.
//   • NO ARCHIVE FLAG either. Linkwarden's "archive" is its page-snapshot feature (the
//     `image`/`pdf`/`monolith` columns), not a "done, put away" state. Quell's archive is
//     therefore represented STRUCTURALLY: a second collection named "<collection> Archive"
//     next to the main one. Archiving moves the link over (a fully hydrated PUT with the
//     other collection id — verified live: the PUT really moves it and touches nothing
//     else), restoring moves it back, and which shelf a link sits on is what a pull reads
//     `isArchived` from. The archive collection is created lazily, only when the first
//     archived article is pushed — a user who never archives never sees it. With no
//     collection configured ("Unorganized" mode) there is no fence and no archive shelf:
//     `isArchived` simply does not round-trip through Linkwarden then.
//   • NO FAVOURITE. Existence in Linkwarden *is* saved-ness, so `isSaved` is true for
//     everything we pull and everything we push. It does not round-trip as a flag.
//   • `cachedHtml` and `summary` — never uploaded, never overwritten by a pull, like
//     everywhere else in this app.
//
//   url         ↔ url
//   title       ↔ name          (there is no `title` field)
//   description ↔ description
//   image       — ✗. Linkwarden's `image` is an archive FORMAT ("jpeg" | "png") in the
//                 request and an archive PATH in the response. It is not an image URL and
//                 must never be read into ours.
//   source      — ✗. Derived from the hostname on the way back in.
//
// ── The PUT trap ────────────────────────────────────────────────────────────
// There is no PATCH, and an omitted field is not "leave it alone". Verified against a live
// server, field by field:
//
//   • `name` omitted        → 200, and the name is WIPED (`name: data.name || ""`).
//   • `description` omitted → 200, and the description is WIPED. The one that bites hardest:
//                             the request looks like it worked.
//   • `tags` omitted        → 400. Required by the schema, and `removePreviousTags` is
//                             hardcoded true, so a PUT that carried no tags would strip them.
//   • `collection` omitted  → 400. Both keys are required: z.object({ id, ownerId }).
//   • `id` omitted          → 400.  `url` omitted → 401 "Invalid URL."
//
// So every PUT this module sends is fully hydrated from the link we just read back.
//
// `pinnedBy` is the one thing deliberately LEFT OUT, and the reason is not the one folklore
// gives. Measured: sending it populated does NOT short-circuit the route — the update still
// applies. But sending it EMPTY unpins the link, and omitting it preserves the pin. Since
// Quell has no concept of a pin and must not clobber one the user set in Linkwarden,
// omitting is exactly right.
//
// ── Collections ─────────────────────────────────────────────────────────────
// `collection: { name }` is NOT find-or-create — `setCollection.ts` special-cases only the
// literal name "Unorganized" and unconditionally CREATEs anything else. Verified: two POSTs
// with `{ name: "Quell Feed" }` produce two collections both called "Quell Feed". Posting
// twenty links that way gives you twenty of them.
// So the id is resolved once per run (GET /collections, create only if it is really
// missing) and every link carries `{ id }`. Scoping the pull to that collection is also
// what keeps a 5 000-link Linkwarden library out of the reader.
//
// And the scope is not just about volume — it is a fence. The user's OTHER collections are
// none of Quell's business: a link that lives outside the Quell collection must never be
// updated by a push or removed by a delete, however well its URL matches. Every lookup this
// module makes is therefore scoped to the collections it owns — since the archive feature
// that is TWO of them, "<name>" and "<name> Archive", resolved together in one request.
//
// ── Transport ───────────────────────────────────────────────────────────────
// Linkwarden sends no Access-Control-Allow-Origin at all (no headers() in next.config.js,
// no middleware, no cors dependency), so a direct browser call dies on CORS. Native goes
// through CapacitorHttp; the browser dev build goes through the /__dav middleware in
// vite.config.js, which is only *named* after WebDAV — it passes the method, the body, the
// Authorization header and Content-Type straight through. Exactly what webdav.js does.

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const API_PATH = '/api/v1'

// Same-origin dev proxy. See getLinkwardenTransport().
const DEV_PROXY_PATH = '/__dav'

const CONNECT_TIMEOUT_MS = 15000
const READ_TIMEOUT_MS = 30000

// A broken server that keeps answering with the cursor we just sent would otherwise spin
// forever.
const MAX_PAGES = 200

// The schema caps these; a longer one is a 400.
const MAX_NAME_CHARS = 2048
const MAX_DESCRIPTION_CHARS = 2048

/** The settings blob the store persists under `settings.linkwarden`. */
export const DEFAULT_LINKWARDEN_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  // The collection Quell owns. Empty means "Unorganized", and a pull that is not scoped to
  // a collection pulls the user's ENTIRE library into the reader — which is why this has a
  // default.
  collectionName: 'Quell Feed',
  enabled: false,
  lastSync: null,
}

// ── Small helpers ───────────────────────────────────────────────────────────

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function toIso(value) {
  if (!value) return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function toText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Identity is the URL, never the id — see src/utils/karakeep.js and src/utils/sync.js. */
export function urlKey(url) {
  const raw = toText(url).trim()
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${host}${path}${parsed.search}`
  } catch {
    return raw.toLowerCase()
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

function normalizeBaseUrl(raw) {
  const value = toText(raw).trim().replace(/\/+$/, '')
  if (!value) return ''

  try {
    const url = new URL(value)
    // A token pasted into the address itself would end up in every log line we build from
    // a URL. It belongs in the Authorization header and nowhere else.
    url.username = ''
    url.password = ''
    return url.toString()
      .replace(/\/+$/, '')
      .replace(new RegExp(`${API_PATH}/*$`), '')
  } catch {
    return value.replace(new RegExp(`${API_PATH}/*$`), '')
  }
}

/**
 * Normalizes the stored settings into the config the requests are built from.
 * The result redacts the token when it is stringified — nothing that serializes a config
 * may carry it off the device.
 *
 * @param {{baseUrl?: string, apiKey?: string, collectionName?: string}} settings
 * @returns {{baseUrl: string, apiKey: string, collectionName: string}}
 */
export function resolveLinkwardenConfig(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}

  const config = {
    baseUrl: normalizeBaseUrl(source.baseUrl),
    apiKey: toText(source.apiKey).trim(),
    collectionName: toText(source.collectionName).trim(),
  }

  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value() {
      return {
        baseUrl: config.baseUrl,
        collectionName: config.collectionName,
        apiKey: config.apiKey ? '[redacted]' : '',
      }
    },
  })

  return config
}

/** True when a request could actually be made. */
export function isLinkwardenConfigured(settings) {
  const { baseUrl, apiKey } = resolveLinkwardenConfig(settings)
  return Boolean(baseUrl && apiKey)
}

function apiUrl(config, path, query = {}) {
  const url = new URL(`${config.baseUrl}${API_PATH}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

// ── Transport ───────────────────────────────────────────────────────────────

/**
 * Which transport a request would use.
 *  • `native` — CapacitorHttp through the OS stack: no CORS, no preflight.
 *  • `proxy`  — browser dev build. A direct call would die on CORS, since Linkwarden
 *               sends no Access-Control-Allow-Origin, so it goes through the Vite
 *               middleware instead.
 */
export function getLinkwardenTransport() {
  if (Capacitor.isNativePlatform()) return 'native'
  if (import.meta.env.DEV) return 'proxy'
  return 'native'
}

function errorCodeForStatus(status) {
  // Linkwarden answers 401 for "not logged in" AND for authorization failures like
  // "Collection is not accessible" — both are, for the user, a bad or under-privileged
  // token.
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  // Nothing in Linkwarden itself rate-limits, but a reverse proxy in front of it will.
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// The server's body never becomes the message. Its error shape is { response: "…" } and it
// happily echoes what it was sent — we will not risk the token in a rendered toast.
function throwForStatus(status) {
  const error = new Error(errorCodeForStatus(status))
  error.status = status
  throw error
}

function parseBody(data) {
  if (data == null || data === '') return null
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

/** The dev-build path. fetch(), not CapacitorHttp — in the browser the latter is a shim
 * that would hit the same CORS wall we are routing around. */
async function proxyRequest({ method, url, headers, data }) {
  const proxyUrl = `${DEV_PROXY_PATH}?url=${encodeURIComponent(url)}`

  let res
  try {
    res = await fetch(proxyUrl, { method, headers, body: data ?? undefined })
  } catch (err) {
    console.error('[linkwarden] proxy request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  return { status: res.status, data: await res.text() }
}

/**
 * One request. Resolves with `{ status, data }` for every HTTP status — an unreachable
 * server is the only thing that throws here (`network_error`); the status mapping is the
 * caller's, because a 409 on a POST is not an error but "it was already there".
 */
async function rawRequest(config, { method, path, query, body }) {
  const url = apiUrl(config, path, query)

  const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  // Always a string: both the native bridge and the proxy pass a string through as-is,
  // while an object would be stringified for us and a string we stringified ourselves
  // would then be double-encoded.
  const data = body === undefined ? undefined : JSON.stringify(body)

  const options = { method, url, headers, data, responseType: 'text' }

  let res
  if (getLinkwardenTransport() === 'proxy') {
    res = await proxyRequest(options)
  } else {
    try {
      const native = await CapacitorHttp.request({
        connectTimeout: CONNECT_TIMEOUT_MS,
        readTimeout: READ_TIMEOUT_MS,
        ...options,
      })
      res = { status: Number(native?.status) || 0, data: native?.data ?? null }
    } catch (err) {
      // Not every platform resolves on a 4xx/5xx — some reject with the response on the
      // error. Recover the status if there is one.
      const status = Number(err?.status ?? err?.response?.status)
      if (Number.isFinite(status) && status >= 100) {
        res = { status, data: err?.data ?? err?.response?.data ?? null }
      } else {
        // Only the error's *name*. Its message may be the transport's, and a transport
        // that echoes the request back would otherwise put the token in the log.
        console.error('[linkwarden] request failed:', err?.name || 'Error')
        throw new Error('network_error')
      }
    }
  }

  // The url is logged, the token is not — it only ever lives in the header.
  console.info('[linkwarden]', method, { url, status: res.status })

  return { status: res.status, data: parseBody(res.data) }
}

/** rawRequest(), but any non-2xx throws the project's error code. */
async function request(config, options) {
  const res = await rawRequest(config, options)
  if (res.status < 200 || res.status > 299) throwForStatus(res.status)
  return res
}

// ── Collections ─────────────────────────────────────────────────────────────

/** "<collection> Archive" — the shelf archived articles live on. Empty in "Unorganized"
 * mode: without a main collection there is no fence and no archive shelf either. */
export function archiveCollectionName(collectionName) {
  const name = toText(collectionName).trim()
  return name ? `${name} Archive` : ''
}

async function listCollections(config) {
  const { data } = await request(config, { method: 'GET', path: '/collections' })
  return Array.isArray(data?.response) ? data.response : []
}

function collectionByName(collections, wanted) {
  if (!wanted) return null
  return collections.find(c =>
    toText(c?.name).trim().toLowerCase() === wanted.toLowerCase()) || null
}

/**
 * Both shelves Quell owns, resolved in ONE /collections request:
 *
 *   mainId    — the saved articles ("Quell Feed")
 *   archiveId — the archived ones ("Quell Feed Archive"), null until it exists
 *   ownerId   — the collections' owner, needed by every PUT that moves a link
 *
 * `create` lets the MAIN collection be created when it is missing; it is what
 * resolveCollectionId used to do and only the write paths may ask for it. The ARCHIVE
 * collection is never created here — ensureArchiveCollection() does that lazily, when a
 * push actually holds an archived article. A user who never archives never gets one, and
 * a pull or a delete never leaves new collections behind.
 *
 * Never `collection: { name }` on a link: that is not find-or-create, it is create — the
 * twentieth link would live in the twentieth collection of the same name.
 *
 * @returns {Promise<{mainId: number|null, archiveId: number|null, ownerId: number|null}>}
 *   all null when no collection is configured (→ "Unorganized", i.e. the whole library)
 */
async function resolveScope(config, { create = false } = {}) {
  const wanted = config.collectionName
  if (!wanted) return { mainId: null, archiveId: null, ownerId: null }

  const collections = await listCollections(config)
  const main = collectionByName(collections, wanted)
  const archive = collectionByName(collections, archiveCollectionName(wanted))

  const scope = {
    mainId: main?.id ?? null,
    archiveId: archive?.id ?? null,
    ownerId: main?.ownerId ?? archive?.ownerId ?? null,
  }

  if (!scope.mainId && create) {
    const created = await request(config, {
      method: 'POST',
      path: '/collections',
      body: { name: wanted },
    })
    scope.mainId = created.data?.response?.id ?? null
    scope.ownerId = scope.ownerId ?? created.data?.response?.ownerId ?? null
  }

  return scope
}

/** The archive collection's id, creating it on first use. Mutates `scope` so one run
 * never creates it twice. */
async function ensureArchiveCollection(config, scope) {
  if (scope.archiveId) return scope.archiveId

  const created = await request(config, {
    method: 'POST',
    path: '/collections',
    body: { name: archiveCollectionName(config.collectionName) },
  })

  scope.archiveId = created.data?.response?.id ?? null
  scope.ownerId = scope.ownerId ?? created.data?.response?.ownerId ?? null
  return scope.archiveId
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/**
 * A Linkwarden link as a store article.
 *
 * `publishedAt` is the link's createdAt — which is the day it was IMPORTED into
 * Linkwarden, because the API has no way to carry a real publish date. That is only ever
 * used for an article this device has never seen; mergeArticle() below refuses to
 * overwrite a date we already have with it.
 */
function linkToArticle(link, newId, isArchived = false) {
  const url = link?.url
  const createdAt = toIso(link?.createdAt) || new Date().toISOString()

  return {
    id: newId(),
    feedId: null,
    source: hostnameOf(url),
    url,
    title: toText(link?.name),
    description: toText(link?.description),
    // NOT link.image — that is an archive path/format, not a picture of the article.
    image: null,
    // Linkwarden has no read flag. A new article is unread; a known one keeps its own
    // state (see mergeArticle).
    isRead: false,
    isSaved: true,
    // Which shelf the link sits on IS the archive state — see the file header.
    isArchived: Boolean(isArchived),
    publishedAt: createdAt,
    cachedHtml: null,
    // The remote's own timestamp, never Date.now(): a freshly pulled article must not look
    // "touched right now" to the WebDAV merge in sync.js.
    updatedAt: createdAt,
  }
}

/** The POST body for a link. No date field exists — publishedAt cannot be sent. */
function articleToLink(article, collectionId) {
  const body = {
    url: article.url,
    name: toText(article.title).slice(0, MAX_NAME_CHARS),
    description: toText(article.description).slice(0, MAX_DESCRIPTION_CHARS),
    type: 'url',
    tags: [],
  }

  // Omitted entirely → the server drops it into "Unorganized" (and creates that if needed).
  if (collectionId) body.collection = { id: collectionId }

  return body
}

/**
 * The PUT body. There is no PATCH, and an omitted field is not "leave it alone" — it is
 * either a wipe (name, description) or a 400 (tags, collection, id). So everything is
 * echoed back from the link we just read. See "The PUT trap" at the top of this file.
 *
 * `pinnedBy` is deliberately absent, and omitting it is what PRESERVES the pin — verified
 * against a live server: a PUT without `pinnedBy` leaves an existing pin untouched while
 * still applying the rest of the update, whereas `pinnedBy: []` would unpin the link.
 * Quell has no pin of its own and will not clobber the user's.
 *
 * `targetCollection` ({ id, ownerId }) moves the link onto the other shelf — archiving
 * and restoring are exactly this PUT with the other collection's id. Omitted, the link
 * stays where it is (the current collection is echoed back, as the schema demands).
 */
function hydratedUpdate(link, article, targetCollection = null) {
  return {
    id: link.id,
    url: article.url,
    // `name: data.name || ""` — an omitted name is a wiped name.
    name: toText(article.title).slice(0, MAX_NAME_CHARS),
    // `description: data.description || ""` — same trap, and the one that bites hardest.
    description: toText(article.description).slice(0, MAX_DESCRIPTION_CHARS),
    icon: link.icon ?? null,
    iconWeight: link.iconWeight ?? null,
    color: link.color ?? null,
    // Required, and both keys of it: the schema is z.object({ id, ownerId }), neither
    // optional. An omitted collection is a 400. /search nests the whole collection on the
    // link; `collectionId` is the flat fallback for a shape that does not.
    collection: {
      id: targetCollection?.id ?? link.collection?.id ?? link.collectionId,
      ownerId: targetCollection?.ownerId ?? link.collection?.ownerId,
    },
    // `removePreviousTags` is hardcoded true, so an omitted `tags` removes them all — and
    // the schema makes it required anyway.
    tags: Array.isArray(link.tags)
      ? link.tags.map(tag => ({ name: toText(tag?.name) })).filter(tag => tag.name)
      : [],
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The link list, page by page, out of /search — /links is deprecated and self-hosters can
 * hard-disable it with DISABLE_DEPRECATED_ROUTES.
 *
 * Two shapes have to be survived: the normal
 * `{ data: { links: [...], nextCursor } }`, and the `{ data: [] }` that a Meilisearch-backed
 * instance answers with when nothing matched. And a server that keeps handing back the
 * cursor we just sent must not spin the loop forever.
 */
async function fetchLinks(config, query = {}) {
  const links = []
  const seen = new Set()
  let cursor = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await request(config, {
      method: 'GET',
      path: '/search',
      query: { ...query, cursor: cursor ?? undefined },
    })

    const payload = data?.data
    const pageLinks = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.links) ? payload.links : []

    links.push(...pageLinks)

    const next = Array.isArray(payload) ? null : payload?.nextCursor
    if (next === null || next === undefined || pageLinks.length === 0) break

    const token = String(next)
    if (seen.has(token)) {
      console.warn('[linkwarden] server repeated a cursor, stopping pagination')
      break
    }
    seen.add(token)
    cursor = next
  }

  return links
}

/**
 * The link with exactly this URL inside the collection Quell owns, or null.
 *
 * Two things the server will not do for us:
 *
 * 1. /search matches on a SUBSTRING of the url (`contains`, and Meilisearch is fuzzier
 *    still). Verified: searching `https://example.com/article` returns BOTH that link and
 *    `https://example.com/article/comments`. The server's answer is a list of candidates
 *    and nothing more — the exact comparison happens here, or a push would decide an
 *    article already exists because a *different* one contains its URL, and a delete would
 *    remove the wrong link entirely.
 *
 * 2. It does not know which collection is ours. An unscoped lookup reaches into the user's
 *    whole library, so the same URL sitting in a collection of their own would be found —
 *    and then updated by a push, or DELETED by an unsave. That is the user's bookmark, not
 *    Quell's. Hence collectionId.
 *
 * @param {number|null} collectionId null → the whole library really is the scope (no
 *   collection configured), which is the documented "Unorganized" mode.
 */
async function findLinkByUrl(config, url, collectionId = null) {
  const links = await fetchLinks(config, {
    searchQueryString: url,
    collectionId: collectionId ?? undefined,
  })
  const key = urlKey(url)
  return links.find(link => urlKey(link?.url) === key) || null
}

/**
 * The link with this URL on either of Quell's shelves, or null. The main collection is
 * asked first — that is where the overwhelming share of links live — and the archive only
 * when it exists. In "Unorganized" mode (no collection configured) the whole library
 * really is the scope, as documented.
 *
 * @returns {Promise<{link: object, archived: boolean}|null>}
 */
async function findLinkInScope(config, url, scope) {
  if (!config.collectionName) {
    const link = await findLinkByUrl(config, url, null)
    return link ? { link, archived: false } : null
  }

  if (scope.mainId) {
    const link = await findLinkByUrl(config, url, scope.mainId)
    if (link) return { link, archived: false }
  }
  if (scope.archiveId) {
    const link = await findLinkByUrl(config, url, scope.archiveId)
    if (link) return { link, archived: true }
  }
  return null
}

// ── The API ─────────────────────────────────────────────────────────────────

/**
 * Checks the address and the token by asking for the collections — the cheapest request
 * that proves the token was accepted.
 *
 * @param {object} settings `settings.linkwarden`
 * @returns {Promise<{ok: true, status: number, collections: number}>}
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed
 */
export async function testLinkwardenConnection(settings) {
  const config = resolveLinkwardenConfig(settings)
  if (!isLinkwardenConfigured(config)) throw new Error('not_configured')

  const { status, data } = await request(config, { method: 'GET', path: '/collections' })

  return {
    ok: true,
    status,
    collections: Array.isArray(data?.response) ? data.response.length : 0,
  }
}

/** The articles this sync is about: saved ones, with a usable URL. */
function pushable(articles) {
  return (Array.isArray(articles) ? articles : [])
    .filter(article => article?.isSaved && isHttpUrl(article.url))
}

/**
 * Pushes the saved articles.
 *
 * Every article is looked up by URL first, so this never creates a second copy of a link
 * that is already there — a sync that duplicates its own output on every run is worse than
 * no sync. When the link exists but its title, description or SHELF (main vs. archive)
 * has drifted from ours, it is updated with a FULLY HYDRATED PUT: Linkwarden has no
 * PATCH, and a partial PUT does not leave the missing fields alone, it wipes them.
 * Archiving and restoring are that same PUT with the other collection's id.
 *
 * `publishedAt` and `isRead` are not sent, because there is nowhere to put them.
 *
 * @param {Array} articles store articles; anything not `isSaved` is ignored
 * @param {object} settings `settings.linkwarden`
 * @param {{remoteIndex?: Map, scope?: object}} [options] internal — syncWithLinkwarden()
 *   has already listed the collections and passes both in, so this does not search once
 *   per article all over again. `remoteIndex` maps urlKey → { link, archived }.
 * @returns {Promise<{pushed: number, skipped: number}>} `pushed` counts creations, moves
 *   and updates, `skipped` the links that were already correct.
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed
 */
export async function pushToLinkwarden(articles, settings, options = {}) {
  const config = resolveLinkwardenConfig(settings)
  if (!isLinkwardenConfigured(config)) throw new Error('not_configured')

  const todo = pushable(articles)
  if (todo.length === 0) return { pushed: 0, skipped: 0 }

  const scope = options.scope || await resolveScope(config, { create: true })

  const index = options.remoteIndex || null
  let pushed = 0
  let skipped = 0

  for (const article of todo) {
    // Only with a collection fence can the archive be represented at all.
    const wantsArchive = Boolean(article.isArchived) && Boolean(config.collectionName)

    const known = index
      ? index.get(urlKey(article.url)) || null
      : await findLinkInScope(config, article.url, scope)

    if (!known) {
      // Created lazily, exactly here: the first archived article is what brings the
      // archive collection into existence.
      const targetId = wantsArchive ? await ensureArchiveCollection(config, scope) : scope.mainId

      const res = await rawRequest(config, {
        method: 'POST',
        path: '/links',
        body: articleToLink(article, targetId),
      })

      // 409 "Link already exists" — the instance has preventDuplicateLinks on and caught a
      // duplicate we did not. That is not an error, it is the outcome we wanted anyway.
      if (res.status === 409) {
        skipped++
        continue
      }
      if (res.status < 200 || res.status > 299) throwForStatus(res.status)

      pushed++
      continue
    }

    // It is already there. Never a second POST — that is the whole point.
    const title = toText(article.title).slice(0, MAX_NAME_CHARS)
    const description = toText(article.description).slice(0, MAX_DESCRIPTION_CHARS)
    const wrongShelf = Boolean(config.collectionName) && wantsArchive !== known.archived

    if (!wrongShelf && toText(known.link.name) === title && toText(known.link.description) === description) {
      skipped++
      continue
    }

    // Moving needs the target collection; staying put echoes the current one back.
    const targetCollection = wrongShelf
      ? {
          id: wantsArchive ? await ensureArchiveCollection(config, scope) : scope.mainId,
          ownerId: scope.ownerId ?? known.link.collection?.ownerId,
        }
      : null

    await request(config, {
      method: 'PUT',
      path: `/links/${encodeURIComponent(known.link.id)}`,
      body: hydratedUpdate(known.link, article, targetCollection),
    })
    pushed++
  }

  return { pushed, skipped }
}

/**
 * Everything on Quell's two shelves, as store articles — the main collection first, then
 * the archive (whose links come back with `isArchived: true`).
 *
 * Scoped to the configured collections: without that, a pull would drag the user's entire
 * Linkwarden library into the reader. With no collection configured it really does pull
 * everything (and then there is no archive shelf to read from).
 *
 * The `publishedAt` on these is the IMPORT date — Linkwarden cannot carry a publish date.
 *
 * @param {object} settings `settings.linkwarden`
 * @param {{newId?: () => string}} [options]
 * @returns {Promise<{articles: Array}>}
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed
 */
export async function pullFromLinkwarden(settings, options = {}) {
  const config = resolveLinkwardenConfig(settings)
  if (!isLinkwardenConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const scope = options.scope || await resolveScope(config, { create: true })

  // Deduped by URL, not by id: a library can hold the same link twice (and a broken
  // paginator can serve the same page twice), and two articles with one URL is a bug the
  // store has no way to recover from. The archive is read FIRST so that a URL somehow
  // sitting on both shelves stays archived — "keep forever" is the safer reading.
  const byUrl = new Map()

  for (const { collectionId, archived } of shelvesOf(config, scope)) {
    if (config.collectionName && !collectionId) continue

    const links = await fetchLinks(config, {
      searchQueryString: '',
      collectionId: collectionId ?? undefined,
    })

    for (const link of links) {
      if (!isHttpUrl(link?.url)) continue
      const key = urlKey(link.url)
      if (!byUrl.has(key)) byUrl.set(key, linkToArticle(link, newId, archived))
    }
  }

  return { articles: [...byUrl.values()] }
}

/** The shelves a pull walks, archive first. In "Unorganized" mode there is only the
 * unscoped library. */
function shelvesOf(config, scope) {
  if (!config.collectionName) return [{ collectionId: null, archived: false }]
  return [
    { collectionId: scope.archiveId, archived: true },
    { collectionId: scope.mainId, archived: false },
  ]
}

/**
 * Merges a remote article into the local one we already have. Pure, and deliberately
 * conservative — this is the function that must never lose data.
 *
 *   • `cachedHtml` and `summary` survive by never being written. The server cannot carry
 *     either.
 *   • `isRead` is LOCAL ONLY. Linkwarden has no read flag, so a pull that touched isRead
 *     could only ever destroy it — every link would come back unread and mark the user's
 *     whole saved list as new again.
 *   • `isArchived` is the one flag that must travel in BOTH directions, restore included.
 *     A plain OR can only ever archive — the sync right after a restore would re-import
 *     the shelf it was supposed to clear, forever. So: last write wins, comparing our
 *     `updatedAt` (stamped on every user action) against the link's own `updatedAt`
 *     (Prisma stamps it on every update — verified live, a collection move included);
 *     with no usable evidence, `true` wins, because a silently un-archived article is
 *     lost content and the opposite mistake costs one tap.
 *   • `publishedAt` is never downgraded. The remote's is the import date; ours is either
 *     the feed's real publish date or the day the link was added. Both are better.
 *   • Text: something beats nothing, and the local value wins a real conflict — it is the
 *     one the user is looking at.
 */
function mergeArticle(local, remote, remoteUpdatedAt) {
  return {
    ...local,
    source: local.source || remote.source,
    title: local.title || remote.title,
    description: local.description || remote.description,
    isSaved: true,
    isArchived: pickArchived(local, remote, remoteUpdatedAt),
    publishedAt: local.publishedAt || remote.publishedAt,
  }
}

/** LWW for the archive flag — see mergeArticle. Ties and missing stamps go to true. */
function pickArchived(local, remote, remoteUpdatedAt) {
  const a = Boolean(local.isArchived)
  const b = Boolean(remote.isArchived)
  if (a === b) return a

  const localAt = Date.parse(local.updatedAt || '') || 0
  const remoteAt = Date.parse(remoteUpdatedAt || '') || 0
  if (localAt > remoteAt) return a
  if (remoteAt > localAt) return b
  return true
}

function changed(before, after) {
  return before.isSaved !== after.isSaved
    || Boolean(before.isArchived) !== Boolean(after.isArchived)
    || before.title !== after.title
    || before.description !== after.description
}

/**
 * The round-trip: list the collection once, merge it into the local articles, then write
 * back only what differs.
 *
 * NOT a two-way sync — see the header of this file. Deletions do not travel unless the
 * store calls deleteFromLinkwarden(), and a link missing from the server never deletes
 * anything here.
 *
 * @param {Array} localArticles the store's FULL article list, not just the saved ones — a
 *   remote link whose URL the device already knows as a feed item must merge into that
 *   item, not turn into a second copy of it.
 * @param {object} settings `settings.linkwarden`
 * @param {{newId?: () => string}} [options]
 * @returns {Promise<{articles: Array, pushed: number, pulled: number}>} `articles` is the
 *   full merged list: assign it to the store and save.
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed
 */
export async function syncWithLinkwarden(localArticles, settings, options = {}) {
  const config = resolveLinkwardenConfig(settings)
  if (!isLinkwardenConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const locals = Array.isArray(localArticles) ? localArticles : []

  // Once per run — never per link, or every push would create a new collection.
  const scope = await resolveScope(config, { create: true })

  // One pass over both shelves gives both halves: what to merge in, and the index that
  // lets the push below skip the per-article search entirely. Archive first — a URL
  // somehow sitting on both shelves stays archived, "keep forever" is the safer reading.
  const remoteIndex = new Map()
  const remoteArticles = new Map()

  for (const { collectionId, archived } of shelvesOf(config, scope)) {
    if (config.collectionName && !collectionId) continue

    const links = await fetchLinks(config, {
      searchQueryString: '',
      collectionId: collectionId ?? undefined,
    })

    for (const link of links) {
      if (!isHttpUrl(link?.url)) continue

      const key = urlKey(link.url)
      if (remoteIndex.has(key)) continue
      remoteIndex.set(key, { link, archived })
      remoteArticles.set(key, linkToArticle(link, newId, archived))
    }
  }

  // 1 ── Pull.
  const merged = []
  const localKeys = new Set()
  let pulled = 0

  for (const local of locals) {
    const key = isHttpUrl(local?.url) ? urlKey(local.url) : null
    if (!key || localKeys.has(key)) {
      merged.push(local)
      continue
    }
    localKeys.add(key)

    const remote = remoteArticles.get(key)
    if (!remote) {
      merged.push(local)
      continue
    }

    const next = mergeArticle(local, remote, remoteIndex.get(key)?.link?.updatedAt)
    if (changed(local, next)) pulled++
    merged.push(next)
  }

  for (const [key, remote] of remoteArticles) {
    if (localKeys.has(key)) continue
    merged.push(remote)
    pulled++
  }

  merged.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))

  // 2 ── Push.
  const { pushed } = await pushToLinkwarden(merged, settings, { remoteIndex, scope })

  return { articles: merged, pushed, pulled }
}

/**
 * Deletes the link behind a URL — but only inside the collections Quell owns, the
 * archive included: a deletion in Quell is a deletion, wherever the link is shelved.
 *
 * The missing half of "the server holds the truth": without it, an article the user
 * deleted in Quell is pulled straight back on the next sync. The store should call it from
 * removeArticle() when Linkwarden is enabled — best-effort, because a failed remote delete
 * must not block the local one.
 *
 * The scope is the whole point of the function's safety. An unscoped lookup would find the
 * same URL wherever the user happens to keep it, and unsaving an article in Quell would
 * then delete a bookmark out of a collection Quell never wrote to. A link the user has
 * moved out of the Quell collections is no longer Quell's to delete, and is left alone.
 *
 * If neither collection exists on the server at all, there is nothing of ours to
 * delete — and we do not create them just to find that out.
 *
 * @param {string} url
 * @param {object} settings `settings.linkwarden`
 * @returns {Promise<{deleted: boolean}>} `false` when there was nothing to delete
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function deleteFromLinkwarden(url, settings) {
  const config = resolveLinkwardenConfig(settings)
  if (!isLinkwardenConfigured(config)) throw new Error('not_configured')
  if (!isHttpUrl(url)) return { deleted: false }

  // Look-up, never create: a delete has nothing to write.
  const scope = await resolveScope(config, { create: false })
  if (config.collectionName && !scope.mainId && !scope.archiveId) return { deleted: false }

  const known = await findLinkInScope(config, url, scope)
  if (!known?.link?.id) return { deleted: false }

  await request(config, {
    method: 'DELETE',
    path: `/links/${encodeURIComponent(known.link.id)}`,
  })

  return { deleted: true }
}
