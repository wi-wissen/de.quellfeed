// WebDAV sync: the file format, the merge, and the round-trip that ties them together.
// The HTTP side lives in src/utils/webdav.js.
//
// ── Why an own JSON file and not the Netscape bookmark file ──────────────────
// src/utils/bookmarks.js stays what it is: the *manual* export/interop format, for
// getting links into a browser or into floccus. It cannot be the sync format — it has
// nowhere to put `image`, `isRead` or `source`, it knows nothing about feeds, and above
// all it has no way to say "this was deleted". A sync format without deletions is a
// format that resurrects everything you throw away, on the next sync, forever.
//
// ── Identity: the URL, never the id ─────────────────────────────────────────
// `id` is a local crypto.randomUUID(). The same article, pulled from the same feed on
// two devices, has two different ids — merging on `id` would duplicate every single
// item. So the wire format has no ids at all: articles are identified by `url`, feeds by
// `url`, and an article points at its feed by `feedUrl`. Every device keeps its own ids
// and maps them back on the way in.
//
// ── What is not synced ──────────────────────────────────────────────────────
// `cachedHtml` never goes into the payload. It is a cache: megabytes of article HTML,
// re-fetchable at any time from the source, and worthless to the other device (which can
// fetch it itself, and only for the articles it actually opens). Syncing it would turn a
// ~100 KB file into a multi-megabyte one that has to be uploaded whole on every change.
// The local cachedHtml is preserved untouched by the merge; it is simply never written
// out and never read in.

import { getFile, putFile, testConnection, isWebdavConfigured } from './webdav.js'

/** Bumped only for changes the old parser cannot survive. New *fields* do not need it. */
export const SYNC_VERSION = 1

/**
 * The settings blob the store persists under `settings.webdav`.
 * `path` is the sync file relative to `baseUrl` (it may be nested: `Apps/Quell/x.json`).
 * The folder it lives in must already exist — we cannot MKCOL it (see webdav.js).
 */
export const DEFAULT_WEBDAV_SETTINGS = {
  baseUrl: '',
  username: '',
  password: '',
  path: 'quellfeed-sync.json',
  enabled: false,
  lastSync: null,
}

/**
 * How long a deletion is remembered. A tombstone has to outlive the longest realistic
 * gap between two syncs of the same account — a phone that was in a drawer for a month
 * must still learn about a deletion. 90 days is generous for that and still bounds the
 * file: even a heavy user deletes on the order of hundreds of items a quarter, and a
 * tombstone is a URL plus a date.
 *
 * The risk of expiring them is the one we accept: a device that has been offline for
 * more than 90 days re-uploads items it never learned were deleted. The alternative —
 * keeping them forever — grows the file without limit, and the file is re-uploaded whole
 * on every sync.
 */
export const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

const EPOCH = 0

// ── Small helpers ───────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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

function toMs(value) {
  if (!value) return EPOCH
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isNaN(ms) ? EPOCH : ms
}

function toText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** Recursively key-sorted JSON — two states are equal iff their canonical form is. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

// ── Timestamps: what "newer" means ──────────────────────────────────────────

/**
 * When this item was last touched by a user. This is the timestamp the whole merge hangs
 * on, so it is worth being precise about what may feed it:
 *
 *   • `updatedAt` — what the store SHOULD set on every user action (see the report).
 *   • `addedAt`   — accepted as a fallback if the store ever grows one.
 *   • `publishedAt` (articles only) — the fallback for data written before `updatedAt`
 *     existed. It is right for the case that matters: an article re-appearing from a feed
 *     refresh carries its old publish date, so it stays deleted, while a link added by
 *     hand right now carries today's date and beats an older tombstone.
 *   • NOT `lastFetched` — that is a machine timestamp. Using it would mean a feed still
 *     being polled on device B looks "touched" every five minutes, and would climb out of
 *     its grave the moment device A deleted it.
 *
 * Nothing at all → epoch, i.e. "no evidence": a tombstone then always wins, which is the
 * safe direction (a deletion that sticks beats an item that resurrects).
 */
function itemTime(item) {
  if (!item) return EPOCH
  return toMs(item.updatedAt) || toMs(item.addedAt) || EPOCH
}

function articleTime(item) {
  if (!item) return EPOCH
  return toMs(item.updatedAt) || toMs(item.addedAt) || toMs(item.publishedAt) || EPOCH
}

// ── Field-level conflict resolution ─────────────────────────────────────────
//
// Two devices can flip the same boolean in opposite directions between two syncs, and
// nothing in the data says which happened later unless the store stamps `updatedAt`.
// Both rules below are therefore two-tiered: use the timestamps when they say something,
// fall back on a rule that is COMMUTATIVE (merge(a,b) === merge(b,a)) when they do not.

/**
 * `isRead`, `isSaved`, `isArchived` and `isQuelled`: the newer write wins; without
 * evidence, `true` wins.
 *
 * Why true: the fallback has to pick a direction, and the two directions are not equally
 * bad. An article read on the phone that shows up unread on the tablet is a bug the user
 * hits every single day, on every device, and it makes the unread count meaningless — the
 * whole point of the reader. The cost of the opposite mistake is one tap ("mark unread"
 * that did not stick). Same for `isSaved`: an extra saved article is a two-tap fix, an
 * article that quietly un-saves itself is lost content.
 *
 * Note that `true` only wins in the *absence* of evidence. Once the store stamps
 * `updatedAt` on markUnread()/toggleSave(), a later "mark unread" propagates properly —
 * the OR is a floor, not a ceiling.
 *
 * `undefined` (as opposed to false) means "this side has never heard of the field" — a
 * file written by an older app version simply lacks `isArchived`/`isQuelled`, and that
 * absence must not read as an explicit false that could win a timestamp race.
 */
function pickFlag(local, remote, localAt, remoteAt) {
  if (local === undefined) return Boolean(remote)
  if (remote === undefined) return Boolean(local)

  const a = Boolean(local)
  const b = Boolean(remote)
  if (a === b) return a

  if (localAt > remoteAt) return a
  if (remoteAt > localAt) return b
  return a || b
}

/**
 * Text-ish fields (title, description, image, summary, …): something beats nothing, then
 * the newer write wins, then — with no evidence at all — the lexicographically larger
 * string. That last tie-break is arbitrary on purpose: it exists so the merge stays
 * commutative and deterministic (both devices compute the same result no matter who
 * merges first). It only ever fires when two devices hold genuinely different text for
 * the same URL and neither can say when they wrote it, which for feed-derived text is
 * near enough to never.
 */
function pickText(local, remote, localAt, remoteAt) {
  const a = toText(local)
  const b = toText(remote)
  if (!a) return b
  if (!b) return a
  if (a === b) return a

  if (localAt > remoteAt) return a
  if (remoteAt > localAt) return b
  return a > b ? a : b
}

/**
 * A user-owned, user-clearable text — a feed's `filterPrompt`. Unlike pickText, the
 * empty string is a real value here: clearing the prompt is an edit that must travel,
 * or the prompt would come back from every other device forever. Only `undefined`
 * (the other side has never heard of the field) counts as "no knowledge". Newer write
 * wins; without evidence the non-empty side, then the larger string — the same
 * commutativity argument as pickText.
 */
function pickUserText(local, remote, localAt, remoteAt) {
  if (local === undefined) return remote === undefined ? undefined : toText(remote)
  if (remote === undefined) return toText(local)

  const a = toText(local)
  const b = toText(remote)
  if (a === b) return a

  if (localAt > remoteAt) return a
  if (remoteAt > localAt) return b
  if (!a || !b) return a || b
  return a > b ? a : b
}

// ── Tombstones ──────────────────────────────────────────────────────────────

export function createEmptyTombstones() {
  return { feeds: {}, articles: {} }
}

function normalizeTombstoneMap(map) {
  if (!isPlainObject(map)) return {}

  const out = {}
  for (const [url, deletedAt] of Object.entries(map)) {
    if (!isHttpUrl(url)) continue
    const iso = toIso(deletedAt)
    if (iso) out[url] = iso
  }
  return out
}

export function normalizeTombstones(tombstones) {
  if (!isPlainObject(tombstones)) return createEmptyTombstones()
  return {
    feeds: normalizeTombstoneMap(tombstones.feeds),
    articles: normalizeTombstoneMap(tombstones.articles),
  }
}

/** Union of two tombstone maps; the later deletion wins. */
function unionTombstoneMaps(a, b) {
  const out = { ...a }
  for (const [url, deletedAt] of Object.entries(b)) {
    if (!out[url] || toMs(deletedAt) > toMs(out[url])) out[url] = deletedAt
  }
  return out
}

function pruneTombstoneMap(map, cutoffMs) {
  const out = {}
  for (const [url, deletedAt] of Object.entries(map)) {
    if (toMs(deletedAt) >= cutoffMs) out[url] = deletedAt
  }
  return out
}

/**
 * Drops tombstones older than `maxAgeMs`. Called by buildSyncPayload() and
 * mergeSyncState(), so the store never has to think about it.
 *
 * @param {{feeds?: object, articles?: object}} tombstones
 * @param {{now?: Date|string|number, maxAgeMs?: number}} [options]
 */
export function pruneTombstones(tombstones, options = {}) {
  const now = options.now ? toMs(options.now) : Date.now()
  const maxAgeMs = options.maxAgeMs ?? TOMBSTONE_MAX_AGE_MS
  const cutoff = now - maxAgeMs
  const normalized = normalizeTombstones(tombstones)

  return {
    feeds: pruneTombstoneMap(normalized.feeds, cutoff),
    articles: pruneTombstoneMap(normalized.articles, cutoff),
  }
}

/**
 * Records a deletion. The store calls this from removeFeed()/removeArticle() — without
 * it, an item deleted here comes straight back from the other device on the next sync.
 *
 * @param {{feeds: object, articles: object}} tombstones the store's tombstone object
 * @param {'feeds'|'articles'} kind
 * @param {string} url
 * @param {Date|string|number} [at]
 * @returns {{feeds: object, articles: object}} a new object; the input is not mutated
 */
export function addTombstone(tombstones, kind, url, at = new Date()) {
  const next = normalizeTombstones(tombstones)
  if (kind !== 'feeds' && kind !== 'articles') return next
  if (!isHttpUrl(url)) return next

  next[kind] = { ...next[kind], [url]: toIso(at) || new Date().toISOString() }
  return next
}

// ── The wire format ─────────────────────────────────────────────────────────

/**
 * The sync file:
 *
 * {
 *   "version": 1,
 *   "updatedAt": "2026-07-12T09:00:00.000Z",
 *   "feeds":    [{ url, title, favicon, lastFetched, filterPrompt, updatedAt? }],
 *   "articles": [{ url, feedUrl, source, title, description, image,
 *                  isRead, isSaved, isArchived, isQuelled, publishedAt, summary,
 *                  updatedAt? }],
 *   "tombstones": { "feeds": { "<url>": "<iso>" }, "articles": { "<url>": "<iso>" } }
 * }
 *
 * No `id`, no `feedId`, no `cachedHtml` — see the header of this file.
 *
 * `isArchived` (archive shelf), `isQuelled` (AI feed filter) and `filterPrompt` (the
 * per-feed filter instruction) are ADDITIVE fields: still version 1, because an older
 * parser reads a file that carries them without breaking (unknown fields are ignored)
 * and a file without them still parses here (they default). See parseSyncPayload.
 *
 * @param {{feeds?: Array, articles?: Array, tombstones?: object}} state the store's state
 * @param {{now?: Date|string|number, maxTombstoneAgeMs?: number}} [options]
 */
export function buildSyncPayload(state, options = {}) {
  const now = options.now ? new Date(toMs(options.now)) : new Date()
  const feeds = Array.isArray(state?.feeds) ? state.feeds : []
  const articles = Array.isArray(state?.articles) ? state.articles : []

  const feedUrlById = new Map()
  for (const feed of feeds) {
    if (feed?.id && isHttpUrl(feed.url)) feedUrlById.set(feed.id, feed.url)
  }

  const payloadFeeds = feeds
    .filter(feed => isHttpUrl(feed?.url))
    .map(feed => stripUndefined({
      url: feed.url,
      title: toText(feed.title),
      favicon: feed.favicon || null,
      lastFetched: toIso(feed.lastFetched),
      // Always written, '' included: an empty prompt means "known to be cleared", and
      // only writing it lets a cleared prompt propagate (see pickUserText).
      filterPrompt: toText(feed.filterPrompt),
      updatedAt: toIso(feed.updatedAt),
    }))

  const payloadArticles = articles
    .filter(article => isHttpUrl(article?.url))
    .map(article => stripUndefined({
      url: article.url,
      // An article's feed is named by URL, because the feed's id differs per device.
      feedUrl: (article.feedId && feedUrlById.get(article.feedId)) || null,
      source: toText(article.source) || null,
      title: toText(article.title),
      description: toText(article.description),
      image: article.image || null,
      isRead: Boolean(article.isRead),
      isSaved: Boolean(article.isSaved),
      isArchived: Boolean(article.isArchived),
      isQuelled: Boolean(article.isQuelled),
      publishedAt: toIso(article.publishedAt),
      summary: toText(article.summary) || undefined,
      updatedAt: toIso(article.updatedAt),
    }))

  return {
    version: SYNC_VERSION,
    updatedAt: now.toISOString(),
    feeds: payloadFeeds,
    articles: payloadArticles,
    tombstones: pruneTombstones(state?.tombstones, {
      now,
      maxAgeMs: options.maxTombstoneAgeMs,
    }),
  }
}

// Keeps nulls (they mean "known to be empty") and drops undefined (means "not set at
// all") — that is what keeps an absent summary out of the file instead of writing "".
function stripUndefined(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export function serializeSyncPayload(payload) {
  return JSON.stringify(payload)
}

function parseRemoteFeed(raw) {
  if (!isPlainObject(raw) || !isHttpUrl(raw.url)) return null
  return {
    url: raw.url,
    title: toText(raw.title),
    favicon: raw.favicon || null,
    lastFetched: toIso(raw.lastFetched),
    // undefined stays undefined: a file from an app version without the field must not
    // look like an explicit "cleared prompt" to the merge.
    filterPrompt: raw.filterPrompt === undefined ? undefined : toText(raw.filterPrompt),
    updatedAt: toIso(raw.updatedAt),
  }
}

function parseRemoteArticle(raw) {
  if (!isPlainObject(raw) || !isHttpUrl(raw.url)) return null
  return {
    url: raw.url,
    feedUrl: isHttpUrl(raw.feedUrl) ? raw.feedUrl : null,
    source: toText(raw.source) || null,
    title: toText(raw.title),
    description: toText(raw.description),
    image: raw.image || null,
    isRead: Boolean(raw.isRead),
    isSaved: Boolean(raw.isSaved),
    // Additive flags: absence (an older writer) is "no knowledge", not false — pickFlag
    // must not let a coerced false win a timestamp race against a real archive/quell.
    isArchived: raw.isArchived === undefined ? undefined : Boolean(raw.isArchived),
    isQuelled: raw.isQuelled === undefined ? undefined : Boolean(raw.isQuelled),
    publishedAt: toIso(raw.publishedAt),
    summary: toText(raw.summary),
    updatedAt: toIso(raw.updatedAt),
  }
}

/**
 * Validates and normalizes a sync file.
 *
 * Strict about the envelope (a foreign JSON, an HTML bookmark file or a truncated upload
 * must not be mistaken for our format), forgiving about everything inside it: unknown
 * fields are ignored, missing fields default, and a single unusable item is dropped
 * rather than taking the whole file down with it. That is what lets a newer version of
 * the app add fields without breaking an older one.
 *
 * @param {string|object} json the file's body — a string, or the object CapacitorHttp
 *   already parsed for us when the server sent `application/json`
 * @returns {{version: number, updatedAt: string|null, feeds: Array, articles: Array,
 *   tombstones: {feeds: object, articles: object}}}
 * @throws {Error} `invalid_payload`
 */
export function parseSyncPayload(json) {
  let raw = json

  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) throw new Error('invalid_payload')
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('invalid_payload')
    }
  }

  if (!isPlainObject(raw)) throw new Error('invalid_payload')

  // `version` is the marker that says "this is ours". Without it, any JSON on the server
  // would be read as an empty sync state — and an empty sync state merged with tombstones
  // is indistinguishable from "the user deleted everything".
  const version = Number(raw.version)
  if (!Number.isFinite(version) || version < 1) throw new Error('invalid_payload')

  if (raw.feeds != null && !Array.isArray(raw.feeds)) throw new Error('invalid_payload')
  if (raw.articles != null && !Array.isArray(raw.articles)) throw new Error('invalid_payload')
  if (raw.tombstones != null && !isPlainObject(raw.tombstones)) throw new Error('invalid_payload')

  return {
    // A newer version is read, not rejected: everything we understand still merges, and
    // refusing would leave the older device permanently unable to sync.
    version,
    updatedAt: toIso(raw.updatedAt),
    feeds: (raw.feeds || []).map(parseRemoteFeed).filter(Boolean),
    articles: (raw.articles || []).map(parseRemoteArticle).filter(Boolean),
    tombstones: normalizeTombstones(raw.tombstones),
  }
}

function emptyPayload() {
  return {
    version: SYNC_VERSION,
    updatedAt: null,
    feeds: [],
    articles: [],
    tombstones: createEmptyTombstones(),
  }
}

// ── The merge ───────────────────────────────────────────────────────────────

function dedupeByUrl(items) {
  const byUrl = new Map()
  for (const item of items) {
    if (isHttpUrl(item?.url) && !byUrl.has(item.url)) byUrl.set(item.url, item)
  }
  return byUrl
}

/** Union of the keys of both maps, local order first — deterministic regardless of input. */
function unionUrls(localMap, remoteMap) {
  return [...new Set([...localMap.keys(), ...remoteMap.keys()])]
}

function mergeFeed(local, remote, newId) {
  if (local && !remote) return local

  const localAt = itemTime(local)
  const remoteAt = itemTime(remote)

  const merged = {
    ...(local || {}),
    // The id stays local. A feed that arrives from the remote gets a fresh one — nobody
    // else's UUID ever enters this device.
    id: local?.id || newId(),
    url: (local || remote).url,
    title: pickText(local?.title, remote?.title, localAt, remoteAt),
    favicon: pickText(local?.favicon, remote?.favicon, localAt, remoteAt) || null,
    // A machine timestamp: the maximum is the honest answer and it is commutative.
    lastFetched: toIso(Math.max(toMs(local?.lastFetched), toMs(remote?.lastFetched))),
  }

  // Additive field (the AI feed filter): '' is a real value — a cleared prompt.
  const filterPrompt = pickUserText(local?.filterPrompt, remote?.filterPrompt, localAt, remoteAt)
  if (filterPrompt !== undefined) merged.filterPrompt = filterPrompt

  const updatedAt = toIso(Math.max(toMs(local?.updatedAt), toMs(remote?.updatedAt)))
  if (updatedAt) merged.updatedAt = updatedAt

  return merged
}

function mergeArticle(local, remote, feedId, newId) {
  if (local && !remote) return local

  const localAt = articleTime(local)
  const remoteAt = articleTime(remote)

  const merged = {
    // Spreading the local article first keeps everything this device knows and the sync
    // file does not — cachedHtml above all, but also any field a future version adds.
    ...(local || {}),
    id: local?.id || newId(),
    feedId,
    url: (local || remote).url,
    source: pickText(local?.source, remote?.source, localAt, remoteAt) || null,
    title: pickText(local?.title, remote?.title, localAt, remoteAt),
    description: pickText(local?.description, remote?.description, localAt, remoteAt),
    image: pickText(local?.image, remote?.image, localAt, remoteAt) || null,
    isRead: pickFlag(local?.isRead, remote?.isRead, localAt, remoteAt),
    isSaved: pickFlag(local?.isSaved, remote?.isSaved, localAt, remoteAt),
    // Additive flags, same conflict rule as isRead/isSaved: LWW, ties go to true.
    isArchived: pickFlag(local?.isArchived, remote?.isArchived, localAt, remoteAt),
    isQuelled: pickFlag(local?.isQuelled, remote?.isQuelled, localAt, remoteAt),
    publishedAt: pickText(local?.publishedAt, remote?.publishedAt, localAt, remoteAt) || null,
    // Never taken from the remote, never sent to it. Purely local, purely a cache.
    cachedHtml: local?.cachedHtml ?? null,
  }

  // The store's invariant, restored after the field-by-field merge: an archived article
  // is always a saved one (that is what keeps it offline-readable forever). Both devices
  // apply the same rule to the same flags, so the merge stays commutative.
  if (merged.isArchived) merged.isSaved = true

  // A summary costs the user's own API credit. It is only ever added, never dropped.
  const summary = pickText(local?.summary, remote?.summary, localAt, remoteAt)
  if (summary) merged.summary = summary

  const updatedAt = toIso(Math.max(toMs(local?.updatedAt), toMs(remote?.updatedAt)))
  if (updatedAt) merged.updatedAt = updatedAt

  return merged
}

/**
 * Merges the local store state with a parsed remote payload.
 *
 * Pure: no network, no storage, no clock of its own beyond `options.now`. Same inputs,
 * same output — that is what makes the conflict retry in syncWithWebdav() safe and the
 * tests worth anything. The one exception is the id minted for an item that arrives from
 * the remote; inject `options.newId` to make even that deterministic.
 *
 * @param {{feeds?: Array, articles?: Array, tombstones?: object}} local store state
 * @param {object|string|null} remote a parsed payload, the raw file, or null (nothing there yet)
 * @param {{now?: Date|string|number, newId?: () => string, maxTombstoneAgeMs?: number}} [options]
 * @returns {{feeds: Array, articles: Array, tombstones: object, changed: boolean,
 *   remoteChanged: boolean, pulled: number, pushed: number}}
 *   `changed` — the local state differs from what went in: persist it.
 *   `remoteChanged` — the merged state differs from the file on the server: upload it.
 *   `pulled` / `pushed` — how many items moved in each direction (for the toast).
 * @throws {Error} `invalid_payload` if `remote` is not a sync file
 */
export function mergeSyncState(local, remote, options = {}) {
  const now = options.now ? new Date(toMs(options.now)) : new Date()
  const newId = options.newId || (() => crypto.randomUUID())

  const remotePayload = remote == null ? emptyPayload() : parseSyncPayload(remote)

  const localFeeds = Array.isArray(local?.feeds) ? local.feeds : []
  const localArticles = Array.isArray(local?.articles) ? local.articles : []
  const localTombstones = normalizeTombstones(local?.tombstones)

  // 1 ── Tombstones: union, later deletion wins.
  const tombstones = {
    feeds: unionTombstoneMaps(localTombstones.feeds, remotePayload.tombstones.feeds),
    articles: unionTombstoneMaps(localTombstones.articles, remotePayload.tombstones.articles),
  }

  // 2 ── Feeds.
  const localFeedByUrl = dedupeByUrl(localFeeds)
  const remoteFeedByUrl = dedupeByUrl(remotePayload.feeds)

  // The store points articles at feeds by local id; the payload does it by url. Both
  // directions are needed below.
  const urlByLocalFeedId = new Map()
  for (const feed of localFeeds) {
    if (feed?.id && isHttpUrl(feed.url)) urlByLocalFeedId.set(feed.id, feed.url)
  }

  const mergedFeeds = []
  const mergedFeedByUrl = new Map()

  for (const url of unionUrls(localFeedByUrl, remoteFeedByUrl)) {
    const localFeed = localFeedByUrl.get(url)
    const remoteFeed = remoteFeedByUrl.get(url)
    const deletedAt = toMs(tombstones.feeds[url])

    // The item only outlives its tombstone if it can prove it was touched afterwards.
    const seenAt = Math.max(itemTime(localFeed), itemTime(remoteFeed))
    if (deletedAt && seenAt <= deletedAt) continue

    // Re-added after the deletion: the grave is emptied, or the next merge would bury it
    // again on the other device.
    if (deletedAt) delete tombstones.feeds[url]

    const feed = mergeFeed(localFeed, remoteFeed, newId)
    mergedFeeds.push(feed)
    mergedFeedByUrl.set(url, feed)
  }

  mergedFeeds.sort((a, b) => toText(a.title).localeCompare(toText(b.title)) || a.url.localeCompare(b.url))

  // 3 ── Articles.
  const localArticleByUrl = dedupeByUrl(localArticles)
  const remoteArticleByUrl = dedupeByUrl(remotePayload.articles)

  const mergedArticles = []

  for (const url of unionUrls(localArticleByUrl, remoteArticleByUrl)) {
    const localArticle = localArticleByUrl.get(url)
    const remoteArticle = remoteArticleByUrl.get(url)
    const deletedAt = toMs(tombstones.articles[url])

    const seenAt = Math.max(articleTime(localArticle), articleTime(remoteArticle))
    if (deletedAt && seenAt <= deletedAt) continue
    if (deletedAt) delete tombstones.articles[url]

    // Which feed the article belongs to, named the only way both devices agree on.
    let feedUrl = (localArticle && urlByLocalFeedId.get(localArticle.feedId))
      || remoteArticle?.feedUrl
      || null
    let detached = false

    // Deleting a feed takes its articles with it (store.removeFeed does exactly that), and
    // the feed's tombstone is what carries that across devices — writing a tombstone per
    // article would bloat the file for no gain.
    //
    // EXCEPT the saved and archived ones: a bookmark is a bookmark and "archived" means
    // keep forever, so those survive the feed's death as feed-less links — the same rule
    // removeFeed applies locally. The flag is merged with the usual pickFlag semantics
    // and is symmetric in both sides, so the merge stays commutative.
    if (feedUrl && !mergedFeedByUrl.has(feedUrl)) {
      const localAt = articleTime(localArticle)
      const remoteAt = articleTime(remoteArticle)
      const bookmarked = pickFlag(localArticle?.isSaved, remoteArticle?.isSaved, localAt, remoteAt)
        || pickFlag(localArticle?.isArchived, remoteArticle?.isArchived, localAt, remoteAt)

      if (!bookmarked) {
        if (tombstones.feeds[feedUrl]) continue
        // The feed is unknown and not deleted either: a remote-only article we cannot
        // place. Keeping a local one costs nothing (it is already on screen); inventing a
        // home for a remote one would drop it into the "links" list, where it does not
        // belong.
        if (!localArticle) continue
      } else {
        // Detached on both devices alike — feedUrl null is what both write to the file.
        feedUrl = null
        detached = true
      }
    }

    const feedId = (feedUrl && mergedFeedByUrl.get(feedUrl)?.id)
      || (detached ? null : localArticle?.feedId)
      || null
    mergedArticles.push(mergeArticle(localArticle, remoteArticle, feedId, newId))
  }

  // Newest first, like the store. The url is a tie-break, not decoration: feed items very
  // often share a publish date, and without a total order two devices would settle on two
  // different orderings of the same set — and the merge would keep reporting "changed".
  mergedArticles.sort((a, b) =>
    toMs(b.publishedAt) - toMs(a.publishedAt) || a.url.localeCompare(b.url))

  // 4 ── Expire old graves. Last, so a tombstone still gets its say in this merge.
  const prunedTombstones = pruneTombstones(tombstones, {
    now,
    maxAgeMs: options.maxTombstoneAgeMs,
  })

  const merged = {
    feeds: mergedFeeds,
    articles: mergedArticles,
    tombstones: prunedTombstones,
  }

  // 5 ── What moved, and in which direction.
  const localBefore = {
    feeds: localFeeds,
    articles: localArticles,
    tombstones: localTombstones,
  }
  const changed = canonical(localBefore) !== canonical(merged)

  const remoteBefore = { ...remotePayload, version: SYNC_VERSION, updatedAt: null }
  const remoteAfter = { ...buildSyncPayload(merged, { now, maxTombstoneAgeMs: options.maxTombstoneAgeMs }), updatedAt: null }
  // The remote's own items are re-normalized through parse → build, so a formatting-only
  // difference (a missing default, a key in another order) never counts as a change.
  const remoteChanged = canonical(normalizeForCompare(remoteBefore)) !== canonical(normalizeForCompare(remoteAfter))

  return {
    ...merged,
    changed,
    remoteChanged,
    pulled: countDifferences(localFeedByUrl, localArticleByUrl, merged),
    pushed: countDifferences(
      dedupeByUrl(remotePayload.feeds),
      dedupeByUrl(remotePayload.articles),
      merged,
      true,
    ),
  }
}

// parse() and build() disagree on nothing but presentation (build drops empty summaries,
// parse fills them in as ''), so both sides go through the same sieve before comparing.
function normalizeForCompare(payload) {
  return {
    version: payload.version,
    feeds: [...payload.feeds]
      // filterPrompt: absent and '' compare equal on purpose — a read-only device must
      // not rewrite the whole file just because an old writer did not know the field.
      .map(f => ({ url: f.url, title: toText(f.title), favicon: f.favicon || null, lastFetched: f.lastFetched || null, filterPrompt: toText(f.filterPrompt), updatedAt: f.updatedAt || null }))
      .sort((a, b) => a.url.localeCompare(b.url)),
    articles: [...payload.articles]
      .map(a => ({
        url: a.url,
        feedUrl: a.feedUrl || null,
        source: a.source || null,
        title: toText(a.title),
        description: toText(a.description),
        image: a.image || null,
        isRead: Boolean(a.isRead),
        isSaved: Boolean(a.isSaved),
        isArchived: Boolean(a.isArchived),
        isQuelled: Boolean(a.isQuelled),
        publishedAt: a.publishedAt || null,
        summary: toText(a.summary),
        updatedAt: a.updatedAt || null,
      }))
      .sort((a, b) => a.url.localeCompare(b.url)),
    tombstones: payload.tombstones,
  }
}

/**
 * How many items the merge changed relative to one side. Deliberately coarse — it feeds a
 * toast ("2 up, 5 down"), not a ledger. A side that never had an item counts it as new; an
 * item the side had and the merge dropped counts as a deletion.
 */
function countDifferences(feedsByUrl, articlesByUrl, merged, isRemoteSide = false) {
  let count = 0

  for (const feed of merged.feeds) {
    const other = feedsByUrl.get(feed.url)
    if (!other) count++
    else if (toText(other.title) !== toText(feed.title)) count++
  }
  for (const url of feedsByUrl.keys()) {
    if (!merged.feeds.some(f => f.url === url)) count++
  }

  const mergedArticleUrls = new Set(merged.articles.map(a => a.url))
  for (const article of merged.articles) {
    const other = articlesByUrl.get(article.url)
    if (!other) {
      count++
      continue
    }
    if (Boolean(other.isRead) !== Boolean(article.isRead)
      || Boolean(other.isSaved) !== Boolean(article.isSaved)
      || Boolean(other.isArchived) !== Boolean(article.isArchived)
      || Boolean(other.isQuelled) !== Boolean(article.isQuelled)
      || toText(other.summary) !== toText(article.summary || '')
      || (isRemoteSide && toText(other.title) !== toText(article.title))) {
      count++
    }
  }
  for (const url of articlesByUrl.keys()) {
    if (!mergedArticleUrls.has(url)) count++
  }

  return count
}

// ── The round-trip ──────────────────────────────────────────────────────────

// Re-exported so the store has a single import for everything sync-related.
export { isWebdavConfigured }

/**
 * Checks server, credentials and path. A 404 on the sync file is not an error — on the
 * first ever sync the file simply is not there yet.
 *
 * @param {object} settings `settings.webdav`
 * @returns {Promise<{ok: true, status: number, exists: boolean}>}
 * @throws {Error} not_configured, dev_unsupported, unauthorized, forbidden, server_error,
 *   network_error, request_failed
 */
export function testWebdavConnection(settings) {
  return testConnection(settings)
}

/**
 * The whole round-trip: GET (with the ETag) → parse → merge → PUT (with If-Match).
 *
 * On 412 (another device wrote between our GET and our PUT) it fetches once more, merges
 * again and retries — which is safe precisely because mergeSyncState() is pure and
 * idempotent: merging the same state twice yields the same state. A second 412 gives up
 * with `conflict`; at that point the user is better served by being told than by an app
 * that hammers the server.
 *
 * Nothing is written when the merge produced no remote change — a device that only reads
 * costs one GET per sync.
 *
 * @param {{feeds?: Array, articles?: Array, tombstones?: object}} localState from the store
 * @param {object} settings `settings.webdav`
 * @param {{now?: Date|string|number, newId?: () => string}} [options]
 * @returns {Promise<{feeds: Array, articles: Array, tombstones: object, changed: boolean,
 *   pushed: number, pulled: number, etag: string|null}>}
 *   The caller assigns feeds/articles/tombstones back into the store and saves them.
 * @throws {Error} not_configured, dev_unsupported, unauthorized, forbidden, not_found
 *   (the folder does not exist), conflict, invalid_payload, server_error, network_error,
 *   request_failed
 */
export async function syncWithWebdav(localState, settings, options = {}) {
  if (!isWebdavConfigured(settings)) throw new Error('not_configured')

  const attempt = async () => {
    const remoteFile = await getFile(settings)
    const remote = remoteFile.status === 404 || !remoteFile.data ? null : remoteFile.data

    const merged = mergeSyncState(localState, remote, options)

    if (!merged.remoteChanged) {
      return { merged, etag: remoteFile.etag, pushed: 0 }
    }

    const body = serializeSyncPayload(buildSyncPayload(merged, { now: options.now }))
    const put = await putFile(settings, '', body, {
      etag: remoteFile.etag,
      // First write ever: refuse to overwrite a file that appeared in the meantime. The
      // 412 then routes into the same retry as any other conflict.
      ifNoneMatch: remoteFile.etag ? null : '*',
    })

    return { merged, etag: put.etag, pushed: merged.pushed }
  }

  let result
  try {
    result = await attempt()
  } catch (err) {
    if (err?.message !== 'conflict') throw err
    // Someone else wrote first. Everything we know still holds — merge it with what is
    // there now and write once more.
    console.info('[sync] write conflict, merging again')
    result = await attempt()
  }

  return {
    feeds: result.merged.feeds,
    articles: result.merged.articles,
    tombstones: result.merged.tombstones,
    changed: result.merged.changed,
    pulled: result.merged.pulled,
    pushed: result.pushed,
    etag: result.etag ?? null,
  }
}
