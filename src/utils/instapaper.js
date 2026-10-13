// Instapaper (API v2) sync for the saved articles.
//
// Same contract as src/utils/karakeep.js and src/utils/linkwarden.js, and the same warning:
// this is NOT the two-way sync src/utils/sync.js does over WebDAV. There are no tombstones
// on the other side, the server holds the truth, and an article deleted in Quell comes
// back on the next pull as long as the bookmark is still there — deleteFromInstapaper()
// is what makes a deletion stick, and the store has to call it. A bookmark that vanishes
// from the server never deletes anything locally: absence is not evidence.
//
// ── Authentication: a personal access token, on purpose ─────────────────────
// API v2 is OAuth 2 authorization-code only, and the code exchange needs the application's
// client secret ("must never be shipped to a browser"). Quell has no backend, so a public
// OAuth flow would mean either a secret inside the APK or a server of ours that sees every
// user's token — both against the point of this app. What v2 offers instead is a personal
// access token, generated on the developer Applications page for the account that owns the
// application, sent as `Authorization: Bearer`. It does not expire (revocation shows up as
// a 401), and it is exactly what the KaraKeep API key and the Linkwarden token are here.
// The price: each user registers their own (Owner Only) application. That is the same
// "bring your own server" model as the other two backends.
//
// ── What Instapaper's "saved" means ─────────────────────────────────────────
// Every Instapaper bookmark is a saved link, so `isSaved` maps onto "exists" — like
// Linkwarden, unlike KaraKeep, which has a favourites shelf to use. There is no
// `favouritesOnly`: pulling gives you your Instapaper library (Home + Archive).
//
//   url          → url
//   title        ↔ title        (sent on create; never overwritten on a later sync)
//   description  ↔ description  (same)
//   isArchived   ↔ archived     (a real flag; moving is POST /bookmarks/{id}/move)
//   publishedAt  ← pubtime, falling back to `time` (the day it was saved). Not uploadable:
//                  the save request has no such field, so a local date is never touched.
//   image        ← image        (read-only)
//   isRead       — ✗. NOT synced, in either direction. `progress` exists, but "scrolled
//                  to 100 %" is not "marked as read" in Quell; stays local (WebDAV has a
//                  real field for it).
//   liked        — not used. It is independent of `archived` and Quell has no counterpart.
//   cachedHtml, summary — never uploaded, never overwritten by a pull.
//
// ── The listing ─────────────────────────────────────────────────────────────
// `since=1` is the one request that returns the whole account, folders included, with no
// page cap beyond `limit`/`offset`. The index built from it is what stops a push from
// re-saving a bookmark that sits in a user-made folder (a save of a known URL "moves it
// back to the top of the list"). Only folder-less bookmarks (Home + Archive) are PULLED;
// the ones in folders are known to the index but not imported.
//
// ── Transport ───────────────────────────────────────────────────────────────
// Native: CapacitorHttp. Browser dev build: the /__dav middleware in vite.config.js, which
// forwards the method, Authorization and Content-Type (the article proxy is GET-only).
// Whether instapaper.com answers CORS preflights is unverified — the proxy sidesteps it.

import { Capacitor, CapacitorHttp } from '@capacitor/core'

const API_BASE = 'https://www.instapaper.com/api/2'
const DEV_PROXY_PATH = '/__dav'

// The documented maximum for `limit`.
const PAGE_LIMIT = 500

// A server that keeps handing back full pages would otherwise spin forever.
// 100 pages × 500 = 50 000 bookmarks, far past any real library.
const MAX_PAGES = 100

const CONNECT_TIMEOUT_MS = 15000
const READ_TIMEOUT_MS = 30000

/** The settings blob the store persists under `settings.instapaper`. */
export const DEFAULT_INSTAPAPER_SETTINGS = {
  accessToken: '',
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

/** Instapaper timestamps are Unix seconds. */
function unixToIso(seconds) {
  const n = Number(seconds)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
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

/**
 * Normalizes the stored settings into the config the requests are built from.
 * The result redacts the token when it is stringified — nothing that serializes a config
 * (a log line, an error report, a bug ticket) may carry the token off the device.
 *
 * @param {{accessToken?: string}} settings
 * @returns {{accessToken: string}}
 */
export function resolveInstapaperConfig(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}

  // A pasted token often drags a "Bearer " prefix or a trailing newline along.
  const config = {
    accessToken: toText(source.accessToken).trim().replace(/^bearer\s+/i, ''),
  }

  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value() {
      return { accessToken: config.accessToken ? '[redacted]' : '' }
    },
  })

  return config
}

/** True when a request could actually be made. */
export function isInstapaperConfigured(settings) {
  return Boolean(resolveInstapaperConfig(settings).accessToken)
}

function apiUrl(path, query = {}) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

// ── Transport ───────────────────────────────────────────────────────────────

function useProxy() {
  return !Capacitor.isNativePlatform() && import.meta.env.DEV
}

function errorCodeForStatus(status) {
  // The token is missing, unknown or revoked.
  if (status === 401) return 'unauthorized'
  // "Application is not approved; unapproved applications may only be used with their
  // owner's account" — or suspended. A real, distinct mistake: the token belongs to
  // someone other than the application's owner.
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// The server's body never becomes the message: its text "may be reworded over time" and
// we will not risk a request being echoed into a toast.
function throwForStatus(status) {
  const error = new Error(errorCodeForStatus(status))
  error.status = status
  throw error
}

/** A body as an object, or null. Never fed into an error — see throwForStatus(). */
function parseBody(data) {
  if (data && typeof data === 'object') return data
  if (typeof data !== 'string' || !data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function send({ method, url, headers, body }) {
  if (useProxy()) {
    const res = await fetch(`${DEV_PROXY_PATH}?url=${encodeURIComponent(url)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: await res.text() }
  }

  const res = await CapacitorHttp.request({
    method,
    url,
    headers,
    data: body,
    connectTimeout: CONNECT_TIMEOUT_MS,
    readTimeout: READ_TIMEOUT_MS,
  })
  return { status: Number(res?.status) || 0, data: res?.data ?? null }
}

/**
 * One request. Throws the project's error codes; an unreachable server is `network_error`.
 * Resolves with `{ status, data }` (parsed body or null) for any 2xx.
 */
async function request(config, { method, path, query, body }) {
  const url = apiUrl(path, query)

  const headers = { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await send({ method, url, headers, body })
  } catch (err) {
    // Only the error's *name*. Its message may be the transport's, and a transport that
    // echoes the request back would otherwise put the token in the log.
    console.error('[instapaper] request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  // The url is logged, the token is not — it only ever lives in the header.
  console.info('[instapaper]', method, { url, status: res.status })

  if (res.status < 200 || res.status > 299) throwForStatus(res.status)

  return { status: res.status, data: parseBody(res.data) }
}

// ── Mapping ─────────────────────────────────────────────────────────────────

function bookmarkUrl(bookmark) {
  return isHttpUrl(bookmark?.url) ? bookmark.url : null
}

/** An Instapaper bookmark as a store article. */
function bookmarkToArticle(bookmark, newId) {
  const url = bookmarkUrl(bookmark)
  const savedAt = unixToIso(bookmark?.time) || new Date().toISOString()

  return {
    id: newId(),
    // A saved link, not a feed item — exactly what the store's addLink() produces.
    feedId: null,
    source: hostnameOf(url),
    url,
    title: toText(bookmark?.title),
    description: toText(bookmark?.description),
    image: bookmark?.image || null,
    // `progress` is not a read flag (see the field table). A fresh pull is unread; a
    // known article keeps its own isRead (see mergeArticle).
    isRead: false,
    isSaved: true,
    isArchived: Boolean(bookmark?.archived),
    publishedAt: unixToIso(bookmark?.pubtime) || savedAt,
    cachedHtml: null,
    // The remote's own timestamp, never Date.now(): a freshly pulled article must not
    // look "touched right now" to the WebDAV merge, or it would climb out of a tombstone
    // it has no right to leave.
    updatedAt: savedAt,
  }
}

/** The POST /bookmarks body. */
function articleToBookmark(article) {
  return stripUndefined({
    url: article.url,
    title: toText(article.title) || undefined,
    description: toText(article.description) || undefined,
    archived: Boolean(article.isArchived),
    // Our URL is the identity we match on. Letting the server canonicalize it could hand
    // back a different spelling than urlKey() folds together, and the next sync would
    // push the article a second time.
    canonicalize: false,
  })
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Every bookmark in the account — Home, Archive and folders — page by page.
 *
 * `since` mode shares each page between bookmarks and `deleted_ids`, so a page can hold
 * fewer bookmarks than `limit`; the offset advances by both, and the loop ends on the
 * first page whose combined size is below `limit`. A repeated first id (a proxy serving
 * the same page twice) ends it as well.
 */
async function fetchAllBookmarks(config) {
  const bookmarks = []
  let offset = 0
  let lastFirstId = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await request(config, {
      method: 'GET',
      path: '/bookmarks',
      query: { since: 1, limit: PAGE_LIMIT, offset },
    })

    const items = Array.isArray(data?.bookmarks) ? data.bookmarks : []
    const deleted = Array.isArray(data?.deleted_ids) ? data.deleted_ids : []
    bookmarks.push(...items)

    const received = items.length + deleted.length
    if (received < PAGE_LIMIT) break

    const firstId = items[0]?.id ?? null
    if (firstId !== null && firstId === lastFirstId) {
      console.warn('[instapaper] server repeated a page, stopping pagination')
      break
    }
    lastFirstId = firstId
    offset += received
  }

  return bookmarks
}

/** urlKey → what the push needs to know about the bookmark. Folder bookmarks included. */
function indexBookmarks(bookmarks) {
  const index = new Map()
  for (const bookmark of bookmarks) {
    const url = bookmarkUrl(bookmark)
    if (!url) continue
    const key = urlKey(url)
    if (index.has(key)) continue
    index.set(key, {
      id: bookmark.id,
      archived: Boolean(bookmark.archived),
      inFolder: bookmark.folder_id != null,
    })
  }
  return index
}

// ── The API ─────────────────────────────────────────────────────────────────

/**
 * Checks the token. Asks for a single bookmark — the cheapest request that still proves
 * the token was accepted (and that the application may be used with this account).
 *
 * @param {object} settings `settings.instapaper`
 * @returns {Promise<{ok: true, status: number}>}
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function testInstapaperConnection(settings) {
  const config = resolveInstapaperConfig(settings)
  if (!isInstapaperConfigured(config)) throw new Error('not_configured')

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

function moveBookmark(config, id, archived) {
  return request(config, {
    method: 'POST',
    path: `/bookmarks/${encodeURIComponent(id)}/move`,
    body: { section: archived ? 'archive' : 'home' },
  })
}

/**
 * Saves the bookmark, or brings the one that is already there in line.
 *
 * POST /bookmarks dedupes server-side, but the documented behaviour for a known URL is
 * "updated with whatever you sent and moved back to the top" — that would reshuffle the
 * user's list on every sync, which is why a bookmark found in the index is never POSTed.
 * Whether `archived` in the body is honoured for an EXISTING bookmark is not documented,
 * so after a POST the answer is checked and a move is sent if it came back wrong.
 *
 * @returns {'created'|'updated'|'skipped'}
 */
async function upsertBookmark(config, article, existing) {
  const wantArchived = Boolean(article.isArchived)

  if (existing) {
    // A bookmark in a user-made folder is left exactly where it is.
    if (existing.inFolder || existing.archived === wantArchived) return 'skipped'
    await moveBookmark(config, existing.id, wantArchived)
    return 'updated'
  }

  const { data } = await request(config, {
    method: 'POST',
    path: '/bookmarks',
    body: articleToBookmark(article),
  })

  if (data?.id != null && Boolean(data.archived) !== wantArchived) {
    await moveBookmark(config, data.id, wantArchived)
  }
  return 'created'
}

/**
 * Pushes the saved articles.
 *
 * @param {Array} articles store articles; anything not `isSaved` is ignored
 * @param {object} settings `settings.instapaper`
 * @param {{remoteIndex?: Map}} [options] `remoteIndex` is internal — syncWithInstapaper()
 *   has already listed the account and passes the index in; without it this lists first.
 * @returns {Promise<{pushed: number, skipped: number}>} `pushed` counts creations and
 *   moves, `skipped` the bookmarks that were already correct.
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function pushToInstapaper(articles, settings, options = {}) {
  const config = resolveInstapaperConfig(settings)
  if (!isInstapaperConfigured(config)) throw new Error('not_configured')

  const index = options.remoteIndex || indexBookmarks(await fetchAllBookmarks(config))
  let pushed = 0
  let skipped = 0

  for (const article of pushable(articles)) {
    const existing = index.get(urlKey(article.url)) || null
    const result = await upsertBookmark(config, article, existing)
    if (result === 'skipped') skipped++
    else pushed++
  }

  return { pushed, skipped }
}

/**
 * Everything in Home and Archive, as store articles. The articles carry a fresh local id
 * and no cachedHtml; merging them into what is already on the device is
 * syncWithInstapaper()'s job.
 *
 * @param {object} settings `settings.instapaper`
 * @param {{newId?: () => string}} [options]
 * @returns {Promise<{articles: Array}>}
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function pullFromInstapaper(settings, options = {}) {
  const config = resolveInstapaperConfig(settings)
  if (!isInstapaperConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const bookmarks = await fetchAllBookmarks(config)

  return { articles: [...remoteArticlesOf(bookmarks, newId).values()] }
}

/**
 * Folder-less bookmarks with a URL, deduped by URL (not id): two articles with one URL
 * is a bug the store has no way to recover from.
 */
function remoteArticlesOf(bookmarks, newId) {
  const byUrl = new Map()
  for (const bookmark of bookmarks) {
    const url = bookmarkUrl(bookmark)
    // Private content has no URL — nothing for a reader to open. A bookmark in a folder
    // is not part of Home or Archive; importing it would pour folders into the reader.
    if (!url || bookmark.folder_id != null) continue

    const key = urlKey(url)
    if (!byUrl.has(key)) byUrl.set(key, bookmarkToArticle(bookmark, newId))
  }
  return byUrl
}

/**
 * Merges a remote article into the local one we already have.
 *
 * Pure, and deliberately conservative — this is the function that must never lose data:
 *   • `cachedHtml` and `summary` survive by never being written.
 *   • `publishedAt` is never replaced: a local date is the feed's real one or the day the
 *     link was added, and both are at least as good as the remote's.
 *   • `isRead` is LOCAL ONLY.
 *   • `isArchived` must travel in BOTH directions, restore included. Instapaper stamps no
 *     modification time on a bookmark, so the evidence is the last sync: an article the
 *     user touched on this device since then wins, otherwise the server's state does
 *     (they changed it elsewhere). With no last sync at all `true` wins — a silently
 *     un-archived article is lost content, the opposite mistake costs one tap.
 */
function mergeArticle(local, remote, lastSync) {
  return {
    ...local,
    source: local.source || remote.source,
    title: local.title || remote.title,
    description: local.description || remote.description,
    image: local.image || remote.image,
    isArchived: pickArchived(local, remote, lastSync),
    // Existence on the server is saved-ness. The store cannot even represent the opposite
    // for a link: an article with feedId: null and isSaved: false is invisible in every
    // list and unreachable by toggleSave().
    isSaved: true,
    publishedAt: local.publishedAt || remote.publishedAt,
  }
}

function pickArchived(local, remote, lastSync) {
  const a = Boolean(local.isArchived)
  const b = Boolean(remote.isArchived)
  if (a === b) return a

  const syncedAt = Date.parse(lastSync || '')
  if (Number.isNaN(syncedAt)) return true
  return (Date.parse(local.updatedAt || '') || 0) > syncedAt ? a : b
}

function changed(before, after) {
  return before.isSaved !== after.isSaved
    || Boolean(before.isArchived) !== Boolean(after.isArchived)
    || before.title !== after.title
    || before.description !== after.description
}

/**
 * The round-trip: list the account once, merge it into the local articles, then write
 * back only what differs.
 *
 * NOT a two-way sync — see the top of this file. A bookmark that disappears from the
 * server never deletes anything locally.
 *
 * @param {Array} localArticles the store's FULL article list, not just the saved ones —
 *   a remote bookmark whose URL the device already knows as a feed item must merge into
 *   that item, not turn into a second copy of it.
 * @param {object} settings `settings.instapaper`; `lastSync` is the archive-merge evidence
 * @param {{newId?: () => string}} [options]
 * @returns {Promise<{articles: Array, pushed: number, pulled: number}>} `articles` is the
 *   full merged list: assign it to the store and save.
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function syncWithInstapaper(localArticles, settings, options = {}) {
  const config = resolveInstapaperConfig(settings)
  if (!isInstapaperConfigured(config)) throw new Error('not_configured')

  const newId = options.newId || (() => crypto.randomUUID())
  const locals = Array.isArray(localArticles) ? localArticles : []
  const lastSync = toIso(settings?.lastSync)

  const bookmarks = await fetchAllBookmarks(config)
  const remoteIndex = indexBookmarks(bookmarks)
  const remoteArticles = remoteArticlesOf(bookmarks, newId)

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

    const next = mergeArticle(local, remote, lastSync)
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
  const { pushed } = await pushToInstapaper(merged, settings, { remoteIndex })

  return { articles: merged, pushed, pulled }
}

/**
 * Deletes the bookmark with this URL, if there is one.
 *
 * The missing half of "the server holds the truth": without it, an article the user
 * deleted in Quell is pulled back on the next sync, forever. The store calls it from
 * removeArticle() when Instapaper is enabled — best-effort, because a delete that fails
 * must not block the local deletion. Deletion is permanent on Instapaper, not archiving.
 *
 * @param {string} url
 * @param {object} settings `settings.instapaper`
 * @returns {Promise<{deleted: boolean}>} `false` when there was nothing to delete
 * @throws {Error} not_configured, unauthorized, forbidden, rate_limited, server_error,
 *   network_error, request_failed
 */
export async function deleteFromInstapaper(url, settings) {
  const config = resolveInstapaperConfig(settings)
  if (!isInstapaperConfigured(config)) throw new Error('not_configured')
  if (!isHttpUrl(url)) return { deleted: false }

  // There is no lookup-by-URL endpoint, so this lists the account. A folder bookmark is
  // deleted too: the user deleted the article, wherever it was filed.
  const id = indexBookmarks(await fetchAllBookmarks(config)).get(urlKey(url))?.id
  if (id == null) return { deleted: false }

  await request(config, { method: 'DELETE', path: `/bookmarks/${encodeURIComponent(id)}` })
  return { deleted: true }
}
