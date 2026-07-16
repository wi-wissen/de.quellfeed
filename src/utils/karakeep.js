// KaraKeep (ex Hoarder) sync for the saved articles.
//
// The WebDAV round-trip in src/utils/sync.js is a *two-way* sync: it owns the file, it
// carries tombstones, and it can therefore let a deletion travel. This is not that.
// KaraKeep is somebody else's library that we push into and read back from:
//
//   • The server holds the truth. There are no tombstones, so an article deleted in Quell
//     comes back on the next pull as long as the bookmark is still on the server. The only
//     honest fix is to delete the bookmark too — deleteFromKarakeep() does that, and the
//     store has to call it from removeArticle() if we want deletions to stick.
//   • We never delete a local article just because it vanished from the server. Absence is
//     not evidence: a filter, a scope error or a half-read page would silently wipe the
//     user's library.
//
// ── What Quell's "saved" means over there ───────────────────────────────────
// Every bookmark in KaraKeep is a saved link, so `isSaved` cannot map onto "exists". It
// maps onto `favourited`: we push saved articles as favourites and pull favourites back
// as saved articles. That keeps the two libraries symmetric and, above all, keeps a user
// with 5 000 KaraKeep bookmarks from having all 5 000 of them poured into their reader.
// `favouritesOnly: false` turns the filter off for the people who do want exactly that.
//
// ── Fields ──────────────────────────────────────────────────────────────────
// The crawler owns `content.*`: it overwrites content.title/description/imageUrl the
// moment it has fetched the page. The *top-level* title/note/summary/archived/favourited
// are the user's and it never touches them — so everything we write goes there, and
// everything we read prefers there.
//
//   url          → content.url (POST body: flat `type: "link"` + `url`)
//   title        → title            (top-level; content.title is crawler-owned)
//   description  → note             (top-level; content.description is crawler-owned)
//   isArchived   ↔ archived         (KaraKeep's own meaning: done, put away. This used
//                  to carry `isRead`, which was a semantic misuse — now that Quell has a
//                  real archive, the field belongs to it.)
//   isRead       — ✗. NOT synced with KaraKeep at all, in either direction: the API has
//                  no read flag, and `archived` is taken (see above). isRead stays local
//                  to the device (and travels via WebDAV, which has a real field for it).
//   isSaved      ↔ favourited
//   publishedAt  ↔ createdAt        (client-settable, unlike Linkwarden's)
//   image        ← content.imageUrl (read-only: no request schema accepts it)
//   source       — NOT their `source`. Theirs is an enum of client kinds
//                  (api|web|cli|mobile|extension|singlefile|rss|import), ours is a
//                  publication name. We send the constant "rss" and derive ours from
//                  the hostname on the way back.
//   cachedHtml, summary — never uploaded, never overwritten by a pull. cachedHtml is a
//                  re-fetchable cache; summary costs the user's own API credit.
//
// ── Transport ───────────────────────────────────────────────────────────────
// plain fetch(), like src/utils/ai.js — KaraKeep answers with
// `Access-Control-Allow-Origin: *` and allows the Authorization header, so this works in
// the browser dev build without the /__dav proxy. (It also sends
// Access-Control-Allow-Credentials, which browsers reject in combination with `*` — so we
// must never send credentials: 'include'. We don't.)

const API_PATH = '/api/v1'

// The server rejects anything above 100 (MAX_NUM_BOOKMARKS_PER_PAGE) with a 400.
const PAGE_LIMIT = 100

// A broken or hostile server that keeps handing back the same cursor would otherwise spin
// forever. 200 pages × 100 = 20 000 bookmarks, which is far past any real library.
const MAX_PAGES = 200

// KaraKeep's title column is capped at 1000 characters; a longer one is a 400.
const MAX_TITLE_CHARS = 1000

/** The settings blob the store persists under `settings.karakeep`. */
export const DEFAULT_KARAKEEP_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  // Quell's saved list ↔ KaraKeep's favourites. Off means "pull the whole library".
  favouritesOnly: true,
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

/**
 * Identity is the URL, never the id — the same article has a different local id on every
 * device (see src/utils/sync.js). The key ignores what does not change the page: the
 * fragment, a trailing slash, a `www.` and the case of the host.
 */
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

function stripUndefined(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

// ── Config ──────────────────────────────────────────────────────────────────

function normalizeBaseUrl(raw) {
  const value = toText(raw).trim().replace(/\/+$/, '')
  if (!value) return ''

  try {
    const url = new URL(value)
    // Credentials pasted into the address itself would end up in every log line we build
    // from a URL. The key belongs in the Authorization header and nowhere else.
    url.username = ''
    url.password = ''
    return url.toString()
      .replace(/\/+$/, '')
      // Users paste the endpoint they found in the docs, not the server root.
      .replace(new RegExp(`${API_PATH}/*$`), '')
  } catch {
    return value.replace(new RegExp(`${API_PATH}/*$`), '')
  }
}

/**
 * Normalizes the stored settings into the config the requests are built from.
 * The result redacts the key when it is stringified — nothing that serializes a config
 * (a log line, an error report, a bug ticket) may carry the key off the device.
 *
 * @param {{baseUrl?: string, apiKey?: string, favouritesOnly?: boolean}} settings
 * @returns {{baseUrl: string, apiKey: string, favouritesOnly: boolean}}
 */
export function resolveKarakeepConfig(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}

  const config = {
    baseUrl: normalizeBaseUrl(source.baseUrl),
    apiKey: toText(source.apiKey).trim(),
    favouritesOnly: source.favouritesOnly !== false,
  }

  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value() {
      return {
        baseUrl: config.baseUrl,
        favouritesOnly: config.favouritesOnly,
        apiKey: config.apiKey ? '[redacted]' : '',
      }
    },
  })

  return config
}

/** True when a request could actually be made. */
export function isKarakeepConfigured(settings) {
  const { baseUrl, apiKey } = resolveKarakeepConfig(settings)
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

function errorCodeForStatus(status) {
  if (status === 401) return 'unauthorized'
  // A scoped API key without bookmarks:readwrite lands here — a real, distinct mistake.
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// The server's body never becomes the message. A 401 answers text/plain ("Unauthorized"),
// errors answer { code, message } — and neither is worth the risk of echoing a request
// (and with it the Authorization header) into a toast.
function throwForStatus(status) {
  const error = new Error(errorCodeForStatus(status))
  error.status = status
  throw error
}

/** Body of a response, or null. Never fed into an error — see throwForStatus(). */
async function readBody(res) {
  let text
  try {
    text = await res.text()
  } catch {
    return null
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * One request. Throws the project's error codes; an unreachable server is `network_error`.
 * Resolves with the parsed body (or null) for any 2xx.
 */
async function request(config, { method, path, query, body, signal }) {
  const url = apiUrl(config, path, query)

  const headers = { Authorization: `Bearer ${config.apiKey}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw new Error('aborted')
    // Only the error's *name*. Its message may be the transport's, and a transport that
    // echoes the request back would otherwise put the key in the log.
    console.error('[karakeep] request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  // The url is logged, the key is not — it only ever lives in the header.
  console.info('[karakeep]', method, { url, status: res.status })

  if (res.status < 200 || res.status > 299) throwForStatus(res.status)

  return { status: res.status, data: await readBody(res) }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

/** The URL of a bookmark, or null for the text/asset kinds we cannot represent. */
function bookmarkUrl(bookmark) {
  const url = bookmark?.content?.url
  return isHttpUrl(url) ? url : null
}

/**
 * A KaraKeep bookmark as a store article.
 *
 * Prefers the user-owned top-level fields over `content.*`, which the crawler rewrites
 * whenever it re-fetches the page. `content.*` is still the right fallback for a bookmark
 * that was created in KaraKeep itself and never had a note typed into it.
 */
function bookmarkToArticle(bookmark, newId) {
  const url = bookmarkUrl(bookmark)
  const createdAt = toIso(bookmark?.createdAt) || new Date().toISOString()

  return {
    id: newId(),
    // A saved link, not a feed item — exactly what the store's addLink() produces.
    feedId: null,
    source: hostnameOf(url),
    url,
    title: toText(bookmark?.title) || toText(bookmark?.content?.title),
    description: toText(bookmark?.note) || toText(bookmark?.content?.description),
    image: bookmark?.content?.imageUrl || null,
    // KaraKeep has no read flag — `archived` is Quell's archive, not "read". A fresh
    // pull is therefore unread; a known article keeps its own isRead (see mergeArticle).
    isRead: false,
    isSaved: true,
    isArchived: Boolean(bookmark?.archived),
    publishedAt: createdAt,
    cachedHtml: null,
    // The remote's own timestamp, never Date.now(): a freshly pulled article must not
    // look "touched right now" to the WebDAV merge, or it would climb out of a tombstone
    // it has no right to leave.
    updatedAt: createdAt,
  }
}

/**
 * The POST body for a link bookmark. Flat — `type` and `url` sit at the top level of the
 * request even though they come back nested under `content` in the response.
 */
function articleToBookmark(article) {
  const title = toText(article.title).slice(0, MAX_TITLE_CHARS)

  return stripUndefined({
    type: 'link',
    url: article.url,
    title: title || undefined,
    // Their `note`, not their `summary`: `summary` is KaraKeep's own AI field and our
    // `summary` (the user's paid-for TL;DR) is never uploaded at all.
    note: toText(article.description) || undefined,
    // Quell's archive, NOT isRead — see the field table at the top of this file.
    archived: Boolean(article.isArchived),
    favourited: Boolean(article.isSaved),
    createdAt: toIso(article.publishedAt) || undefined,
    // Their enum of client kinds, NOT our publication name.
    source: 'rss',
  })
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every bookmark, page by page.
 *
 * `nextCursor` is an opaque string and `null` on the last page. A server that keeps
 * answering with the cursor we just sent — a bug, or a proxy serving a cached page — would
 * spin here forever, so a repeated cursor ends the loop just as a missing one does.
 */
async function fetchAllBookmarks(config, options = {}) {
  const bookmarks = []
  const seen = new Set()
  let cursor = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await request(config, {
      method: 'GET',
      path: '/bookmarks',
      query: {
        limit: PAGE_LIMIT,
        cursor: cursor || undefined,
        favourited: config.favouritesOnly ? 'true' : undefined,
        // Megabytes of crawled article HTML we would only throw away.
        includeContent: 'false',
      },
      signal: options.signal,
    })

    const page_ = Array.isArray(data?.bookmarks) ? data.bookmarks : []
    bookmarks.push(...page_)

    const next = data?.nextCursor
    if (!next || typeof next !== 'string') break
    if (seen.has(next)) {
      console.warn('[karakeep] server repeated a cursor, stopping pagination')
      break
    }
    seen.add(next)
    cursor = next
  }

  return bookmarks
}

/** The same URL with `www.` added or removed — see findBookmarkIdByUrl(). */
function swapWww(url) {
  try {
    const parsed = new URL(url)
    parsed.hostname = /^www\./i.test(parsed.hostname)
      ? parsed.hostname.replace(/^www\./i, '')
      : `www.${parsed.hostname}`
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * The id of the bookmark with this URL, or null.
 *
 * `check-url` is the endpoint built for exactly this question and far cheaper than listing
 * the library, but its normalization is NOT ours: it folds away the fragment, a trailing
 * slash and the case of scheme and host — and stops there. `www.example.com/x` does not
 * find a bookmark stored as `example.com/x`, though urlKey() (and therefore every match we
 * make against a listed library) treats the two as one page. So we ask a second time for
 * the other spelling of the host; without it a deletion silently misses its bookmark and
 * the article is pulled straight back on the next sync.
 */
async function findBookmarkIdByUrl(config, url, options = {}) {
  const ask = async candidate => {
    const { data } = await request(config, {
      method: 'GET',
      path: '/bookmarks/check-url',
      query: { url: candidate },
      signal: options.signal,
    })
    return data?.bookmarkId || null
  }

  const direct = await ask(url)
  if (direct) return direct

  const alternate = swapWww(url)
  return alternate ? await ask(alternate) : null
}

// ── The API ─────────────────────────────────────────────────────────────────

/**
 * Checks the address and the key. Asks for a single bookmark — the cheapest request that
 * still proves the key was accepted and carries the right scope.
 *
 * @param {object} settings `settings.karakeep`
 * @returns {Promise<{ok: true, status: number}>}
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed
 */
export async function testKarakeepConnection(settings) {
  const config = resolveKarakeepConfig(settings)
  if (!isKarakeepConfigured(config)) throw new Error('not_configured')

  const { status } = await request(config, {
    method: 'GET',
    path: '/bookmarks',
    query: { limit: 1 },
  })

  return { ok: true, status }
}

/** The articles this sync is about: saved ones, with a usable URL. */
function pushable(articles) {
  return (Array.isArray(articles) ? articles : [])
    .filter(article => article?.isSaved && isHttpUrl(article.url))
}

/**
 * The flags the server should end up with for this article.
 *
 * Only these: title, note and createdAt may have been edited in KaraKeep, and a sync that
 * overwrites the user's own curation on every run is a sync they will turn off.
 *
 * `favourited` is written only under `favouritesOnly` — that setting *is* the claim that
 * the favourites are Quell's saved shelf. With it off we pull the whole library, so every
 * bookmark becomes a saved article (the store cannot represent a link that is not saved),
 * and writing the flag back would silently favourite the user's entire library.
 */
function desiredFlags(article, config) {
  const flags = { archived: Boolean(article.isArchived) }
  if (config.favouritesOnly) flags.favourited = Boolean(article.isSaved)
  return flags
}

/** The subset of `want` that `have` does not already agree with. `null` means "unknown". */
function flagDiff(have, want) {
  const patch = {}
  for (const [key, value] of Object.entries(want)) {
    if (!have || have[key] !== value) patch[key] = value
  }
  return patch
}

/**
 * Creates the bookmark, or brings the one that is already there in line.
 *
 * POST /bookmarks does dedupe, but ONLY on a byte-identical URL, and when it does it is a
 * pure no-op: it answers 200 with `alreadyExists: true`, hands back the bookmark as it
 * stands and silently drops every field of the body — title, note, archived, favourited,
 * createdAt. So a POST can never be the thing that updates a flag; only a PATCH can.
 * (A URL differing by no more than a fragment or a trailing slash is *not* deduped and
 * yields a second bookmark, which is why `existing` is resolved through urlKey/check-url
 * and never left to the server.)
 *
 * @returns {'created'|'updated'|'skipped'}
 */
async function upsertBookmark(config, article, existing, options) {
  const want = desiredFlags(article, config)

  // `existing` is either an indexed bookmark (id + flags) or a bare id from check-url,
  // whose flags we have not paid a request to learn.
  let id = typeof existing === 'string' ? existing : existing?.id || null
  let have = typeof existing === 'object' && existing ? { archived: Boolean(existing.archived), favourited: Boolean(existing.favourited) } : null

  if (!id) {
    const { data } = await request(config, {
      method: 'POST',
      path: '/bookmarks',
      body: articleToBookmark(article),
      signal: options.signal,
    })

    if (!data?.alreadyExists) return 'created'

    // It was there after all — a URL we failed to match, or another device racing us.
    // The POST changed nothing, so fall through to the PATCH with what it told us.
    id = data.id
    have = { archived: Boolean(data.archived), favourited: Boolean(data.favourited) }
  }

  const patch = flagDiff(have, want)
  if (!Object.keys(patch).length) return 'skipped'

  await request(config, {
    method: 'PATCH',
    path: `/bookmarks/${encodeURIComponent(id)}`,
    body: patch,
    signal: options.signal,
  })
  return 'updated'
}

/**
 * Pushes the saved articles.
 *
 * The whole point of resolving the URL first is that this never creates a second copy of a
 * bookmark that is already there — a sync that duplicates its own output on every run is
 * worse than no sync — and that a bookmark which *is* there ends up with our flags, which
 * a re-POST would not give it (see upsertBookmark).
 *
 * A miss in `remoteIndex` is not proof of absence: with `favouritesOnly` the index holds
 * only the favourites, and the article may well exist on the server as a plain bookmark.
 * Those fall back to check-url. That is also what makes the sync converge — the bookmark is
 * PATCHed to favourited, so the next listing contains it and the fallback is never paid
 * again.
 *
 * @param {Array} articles store articles; anything not `isSaved` is ignored
 * @param {object} settings `settings.karakeep`
 * @param {{signal?: AbortSignal, remoteIndex?: Map}} [options] `remoteIndex` is internal —
 *   syncWithKarakeep() has already listed the library and passes it in so this does not
 *   ask check-url once per article all over again.
 * @returns {Promise<{pushed: number, skipped: number}>} `pushed` counts creations and
 *   flag updates, `skipped` the bookmarks that were already correct.
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed, aborted
 */
export async function pushToKarakeep(articles, settings, options = {}) {
  const config = resolveKarakeepConfig(settings)
  if (!isKarakeepConfigured(config)) throw new Error('not_configured')

  const index = options.remoteIndex || null
  let pushed = 0
  let skipped = 0

  for (const article of pushable(articles)) {
    const indexed = index ? index.get(urlKey(article.url)) || null : null
    const existing = indexed || await findBookmarkIdByUrl(config, article.url, options)

    const result = await upsertBookmark(config, article, existing, options)
    if (result === 'skipped') skipped++
    else pushed++
  }

  return { pushed, skipped }
}

/**
 * Everything on the server, as store articles.
 *
 * With `favouritesOnly` (the default) that is the favourites — Quell's saved list and
 * KaraKeep's favourites are the same shelf. The articles carry a fresh local id and no
 * cachedHtml; merging them into what is already on the device is syncWithKarakeep()'s job.
 *
 * @param {object} settings `settings.karakeep`
 * @param {{signal?: AbortSignal, newId?: () => string}} [options]
 * @returns {Promise<{articles: Array}>}
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed, aborted
 */
export async function pullFromKarakeep(settings, options = {}) {
  const config = resolveKarakeepConfig(settings)
  if (!isKarakeepConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const bookmarks = await fetchAllBookmarks(config, options)

  // Deduped by URL, not by id: a library can hold the same link twice (and a broken
  // paginator can serve the same page twice), and two articles with one URL is a bug the
  // store has no way to recover from.
  const byUrl = new Map()
  for (const bookmark of bookmarks) {
    // A text note or an uploaded PDF has no URL. There is nothing for a reader to open.
    const url = bookmarkUrl(bookmark)
    if (!url) continue

    const key = urlKey(url)
    if (!byUrl.has(key)) byUrl.set(key, bookmarkToArticle(bookmark, newId))
  }

  return { articles: [...byUrl.values()] }
}

/**
 * Merges a remote article into the local one we already have.
 *
 * Pure, and deliberately conservative — this is the function that must never lose data:
 *   • `cachedHtml` and `summary` survive by never being written (they come in on the
 *     spread and nothing below touches them). The server cannot carry either.
 *   • `publishedAt` is never downgraded. A local date is either the feed's real publish
 *     date or the day the link was added; the remote's `createdAt` is at best the same
 *     and at worst the day it was imported into KaraKeep.
 *   • `isRead` is LOCAL ONLY. KaraKeep's `archived` is Quell's archive now, so there is
 *     no read flag on the other side — a pull that touched isRead could only destroy it.
 *   • `isArchived` is the one flag that must travel in BOTH directions, restore included.
 *     A plain OR can only ever archive — measured live: after a restore in Quell, the OR
 *     re-imported the server's `archived: true` on the very sync that was supposed to
 *     clear it, forever. So it is the same rule as mergeSyncState(): last write wins,
 *     comparing our `updatedAt` (stamped on every user action) against the bookmark's
 *     `modifiedAt` (the server stamps it on every PATCH — verified live); with no usable
 *     evidence, `true` wins, because a silently un-archived article is lost content and
 *     the opposite mistake costs one tap.
 */
function mergeArticle(local, remote, remoteModifiedAt) {
  return {
    ...local,
    source: local.source || remote.source,
    title: local.title || remote.title,
    description: local.description || remote.description,
    image: local.image || remote.image,
    isArchived: pickArchived(local, remote, remoteModifiedAt),
    // Existence on the server is saved-ness. The store cannot even represent the opposite
    // for a link: an article with feedId: null and isSaved: false is invisible in every
    // list and unreachable by toggleSave().
    isSaved: true,
    publishedAt: local.publishedAt || remote.publishedAt,
  }
}

/** LWW for the archive flag — see mergeArticle. Ties and missing stamps go to true. */
function pickArchived(local, remote, remoteModifiedAt) {
  const a = Boolean(local.isArchived)
  const b = Boolean(remote.isArchived)
  if (a === b) return a

  const localAt = Date.parse(local.updatedAt || '') || 0
  const remoteAt = Date.parse(remoteModifiedAt || '') || 0
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
 * The round-trip: list the library once, merge it into the local articles, then write back
 * only what differs.
 *
 * NOT a two-way sync. There are no tombstones on the other side, so an article deleted in
 * Quell reappears here as long as the bookmark still exists on the server — call
 * deleteFromKarakeep() from the store's removeArticle() if deletions are to stick. And a
 * bookmark that disappears from the server never deletes anything locally: absence is not
 * evidence.
 *
 * @param {Array} localArticles the store's FULL article list, not just the saved ones —
 *   a remote bookmark whose URL the device already knows as a feed item must merge into
 *   that item, not turn into a second copy of it.
 * @param {object} settings `settings.karakeep`
 * @param {{signal?: AbortSignal, newId?: () => string}} [options]
 * @returns {Promise<{articles: Array, pushed: number, pulled: number}>} `articles` is the
 *   full merged list: assign it to the store and save.
 * @throws {Error} not_configured, unauthorized, forbidden, not_found, rate_limited,
 *   server_error, network_error, request_failed, aborted
 */
export async function syncWithKarakeep(localArticles, settings, options = {}) {
  const config = resolveKarakeepConfig(settings)
  if (!isKarakeepConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const locals = Array.isArray(localArticles) ? localArticles : []

  const bookmarks = await fetchAllBookmarks(config, options)

  // One pass over the library gives us both halves: what to merge in, and the index that
  // lets the push below skip check-url entirely.
  const remoteIndex = new Map()
  const remoteArticles = new Map()

  for (const bookmark of bookmarks) {
    const url = bookmarkUrl(bookmark)
    if (!url) continue

    const key = urlKey(url)
    remoteIndex.set(key, {
      id: bookmark.id,
      archived: Boolean(bookmark.archived),
      favourited: Boolean(bookmark.favourited),
      // The server's own modification stamp — what the archive LWW compares against.
      modifiedAt: toIso(bookmark.modifiedAt),
    })
    if (!remoteArticles.has(key)) remoteArticles.set(key, bookmarkToArticle(bookmark, newId))
  }

  // 1 ── Pull: merge into what the device already has, then add what it does not.
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

    const next = mergeArticle(local, remote, remoteIndex.get(key)?.modifiedAt)
    if (changed(local, next)) pulled++
    merged.push(next)
  }

  for (const [key, remote] of remoteArticles) {
    if (localKeys.has(key)) continue
    merged.push(remote)
    pulled++
  }

  merged.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))

  // 2 ── Push: the merged flags are what the server should end up with.
  const { pushed } = await pushToKarakeep(merged, settings, { ...options, remoteIndex })

  return { articles: merged, pushed, pulled }
}

/**
 * Deletes the bookmark with this URL, if there is one.
 *
 * This is the missing half of "the server holds the truth": without it, an article the
 * user deleted in Quell is simply pulled back on the next sync, forever. The store should
 * call it from removeArticle() when KaraKeep is enabled — best-effort, because a delete
 * that fails must not block the local deletion.
 *
 * @param {string} url
 * @param {object} settings `settings.karakeep`
 * @returns {Promise<{deleted: boolean}>} `false` when there was nothing to delete
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function deleteFromKarakeep(url, settings, options = {}) {
  const config = resolveKarakeepConfig(settings)
  if (!isKarakeepConfigured(config)) throw new Error('not_configured')
  if (!isHttpUrl(url)) return { deleted: false }

  const id = await findBookmarkIdByUrl(config, url, options)
  if (!id) return { deleted: false }

  await request(config, {
    method: 'DELETE',
    path: `/bookmarks/${encodeURIComponent(id)}`,
    signal: options.signal,
  })

  return { deleted: true }
}
