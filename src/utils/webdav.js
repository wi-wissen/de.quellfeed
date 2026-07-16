// WebDAV transport for the sync file. The format itself lives in src/utils/sync.js —
// this module only moves bytes and turns HTTP status codes into the project's error
// codes.
//
// ── Why this module only ever speaks GET and PUT ─────────────────────────────
// On Android, CapacitorHttp hands the method straight to
// HttpURLConnection.setRequestMethod(), which accepts nothing but OPTIONS, GET, HEAD,
// POST, PUT, DELETE, TRACE and PATCH — a PROPFIND or MKCOL throws a ProtocolException
// before the request ever leaves the device. So we never list a collection and never
// create one:
//   • the user creates the sync folder themselves (once, in their file manager),
//   • a missing folder surfaces on the first PUT as HTTP 409 (sabre/dav answers a PUT
//     into a non-existent collection with 409 Conflict), which we map to `not_found`.
//
// ── Concurrency ─────────────────────────────────────────────────────────────
// GET returns the file's ETag; PUT sends it back as `If-Match`, so a second device
// that wrote in the meantime makes the server answer 412 → `conflict`. The caller is
// expected to re-GET, merge again and retry. On Nextcloud/ownCloud (sabre/dav) this is
// guaranteed — Server.php runs checkPreconditions() for every method. On Synology and
// mailbox.org it is unverified, which is why If-Match is a safety net and NOT the thing
// correctness rests on: mergeSyncState() is a union merge with tombstones, so even a
// lost update only costs one sync round, never data.

import { Capacitor, CapacitorHttp } from '@capacitor/core'

// The settings object itself lives in src/utils/sync.js (DEFAULT_WEBDAV_SETTINGS) — it is
// the store's contract, and it carries fields (`enabled`, `lastSync`) this transport has
// no business knowing about. What this module needs is `{ baseUrl, username, password,
// path }`, and the settings object satisfies that shape, so callers pass it straight in.

// Nextcloud/ownCloud put every user's files behind this prefix; the hint is worth a
// constant because it is the single most common configuration mistake.
export const NEXTCLOUD_DAV_PREFIX = '/remote.php/dav/files/'

const CONNECT_TIMEOUT_MS = 15000
const READ_TIMEOUT_MS = 30000

// ── Config ──────────────────────────────────────────────────────────────────

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '')
  if (!value) return ''

  try {
    const url = new URL(value)
    // Credentials pasted into the URL itself (https://user:pass@host/…) would end up
    // in every log line and in every error we build from a URL. The password belongs
    // in the Authorization header and nowhere else.
    url.username = ''
    url.password = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return value
  }
}

function splitSegments(path) {
  return String(path || '')
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
}

function encodeSegment(segment) {
  // A segment that already carries percent-escapes was pasted from an address bar —
  // encoding it again would turn "My%20Files" into "My%2520Files".
  if (/%[0-9a-fA-F]{2}/.test(segment)) return segment
  return encodeURIComponent(segment)
}

/**
 * Normalizes the stored settings into the config the requests are built from.
 * The returned object redacts the password when it is stringified — nothing that
 * serializes a config (a log line, an error report) may carry the password off the
 * device.
 *
 * @param {{baseUrl?: string, username?: string, password?: string, path?: string}} config
 * @returns {{baseUrl: string, username: string, password: string, path: string}}
 */
export function resolveWebdavConfig(config) {
  const source = config && typeof config === 'object' ? config : {}

  const resolved = {
    baseUrl: normalizeBaseUrl(source.baseUrl),
    username: String(source.username || '').trim(),
    password: String(source.password || ''),
    path: splitSegments(source.path).join('/'),
  }

  Object.defineProperty(resolved, 'toJSON', {
    enumerable: false,
    value() {
      return {
        baseUrl: resolved.baseUrl,
        username: resolved.username,
        path: resolved.path,
        password: resolved.password ? '[redacted]' : '',
      }
    },
  })

  return resolved
}

/** True when a request could actually be made. */
export function isWebdavConfigured(config) {
  const { baseUrl, username, password } = resolveWebdavConfig(config)
  return Boolean(baseUrl && username && password)
}

/**
 * Absolute URL of `path` below `config.path`.
 *
 * `config.path` is the resource below `baseUrl` — normally the sync file itself
 * (`quellfeed-sync.json`, possibly nested: `Apps/Quell/quellfeed-sync.json`). The extra
 * `path` argument appends to it, which is what makes the transport reusable for a second
 * file later. Every segment is percent-encoded, so folder names with spaces or umlauts
 * work.
 */
export function buildWebdavUrl(config, path = '') {
  const resolved = resolveWebdavConfig(config)
  const segments = [...splitSegments(resolved.path), ...splitSegments(path)]
  if (segments.length === 0) return resolved.baseUrl
  return `${resolved.baseUrl}/${segments.map(encodeSegment).join('/')}`
}

// btoa() is a byte function: it throws on anything above U+00FF, which is every
// password with an umlaut, an emoji or a Cyrillic letter in it. RFC 7617 says the
// credentials are encoded before base64 — we use UTF-8, like every WebDAV server does.
function basicAuthHeader(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

// ── Transport ───────────────────────────────────────────────────────────────

// Same-origin dev proxy for WebDAV, served by the middleware in vite.config.js.
// Unlike /__proxy it passes PUT bodies, Authorization and If-Match through, and hands
// the ETag back — without which conflict detection would be dead in the browser.
const DEV_DAV_PROXY_PATH = '/__dav'

/**
 * Which transport a request would use.
 *  • `native` — CapacitorHttp through the OS stack: no CORS, no preflight.
 *  • `proxy`  — browser dev build. A direct call would die on CORS (no WebDAV server
 *               sends Access-Control-Allow-Origin for an authenticated PUT), so it
 *               goes through the Vite middleware instead.
 */
export function getWebdavTransport() {
  if (Capacitor.isNativePlatform()) return 'native'
  if (import.meta.env.DEV) return 'proxy'
  return 'native'
}

/**
 * The dev-build path. Deliberately fetch() and not CapacitorHttp: in the browser the
 * latter is a shim that would hit the same CORS wall we are routing around.
 */
async function proxyRequest({ method, url, headers, data, responseType }) {
  const proxyUrl = `${DEV_DAV_PROXY_PATH}?url=${encodeURIComponent(url)}`

  let res
  try {
    res = await fetch(proxyUrl, { method, headers, body: data ?? undefined })
  } catch (err) {
    console.error('[webdav] proxy request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  const responseHeaders = {}
  res.headers.forEach((value, key) => { responseHeaders[key] = value })

  return {
    status: res.status,
    data: await res.text(),
    headers: responseHeaders,
  }
}

function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value == null ? null : String(value)
  }
  return null
}

/**
 * Maps a status to the project's error codes. 404 is a real error only where the caller
 * says so — getFile() reports it as data instead.
 */
function errorCodeForStatus(status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  // 409 = the parent collection does not exist. For us that is the same mistake as a
  // 404: the folder the user typed is not there.
  if (status === 404 || status === 409) return 'not_found'
  if (status === 412) return 'conflict'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// The server's body is never part of the message: a WebDAV error document may echo the
// request back at us, and we will not risk the password landing in a rendered toast.
function throwForStatus(status) {
  const error = new Error(errorCodeForStatus(status))
  error.status = status
  throw error
}

/**
 * One request. Resolves with `{ status, data, headers }` for every HTTP status — an
 * unreachable server is the only thing that throws (`network_error`).
 */
async function request(options) {
  if (getWebdavTransport() === 'proxy') return proxyRequest(options)

  try {
    const res = await CapacitorHttp.request({
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: READ_TIMEOUT_MS,
      ...options,
    })
    return {
      status: Number(res?.status) || 0,
      data: res?.data ?? null,
      headers: res?.headers || {},
    }
  } catch (err) {
    // Not every platform resolves on a 4xx/5xx — some reject with the response on the
    // error. Recover the status if there is one, so a 412 stays a conflict instead of
    // becoming a network error.
    const status = Number(err?.status ?? err?.response?.status)
    if (Number.isFinite(status) && status >= 100) {
      return {
        status,
        data: err?.data ?? err?.response?.data ?? null,
        headers: err?.headers || err?.response?.headers || {},
      }
    }

    // Only the error's *name* is logged. Its message may be the server's, and a server
    // that echoes the Authorization header back would otherwise end up in the log.
    console.error('[webdav] request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Downloads a file.
 *
 * A 404 is not an error — it is the answer "there is no sync file yet", which is the
 * normal state on the very first sync. It comes back as `{ status: 404, data: null }`.
 *
 * @param {{baseUrl: string, username: string, password: string, path: string}} config
 * @param {string} [path] appended to `config.path`; omit when `config.path` is the file
 * @returns {Promise<{status: number, data: string|object|null, etag: string|null}>}
 *   `data` is the body; CapacitorHttp parses it into an object when the server sends
 *   `application/json`, so callers must tolerate both (parseSyncPayload() does).
 * @throws {Error} not_configured, dev_unsupported, unauthorized, forbidden, conflict,
 *   server_error, network_error, request_failed
 */
export async function getFile(config, path = '') {
  if (!isWebdavConfigured(config)) throw new Error('not_configured')

  const resolved = resolveWebdavConfig(config)
  const url = buildWebdavUrl(resolved, path)

  const res = await request({
    method: 'GET',
    url,
    headers: {
      Authorization: basicAuthHeader(resolved.username, resolved.password),
      Accept: '*/*',
      // Proxies and Nextcloud both like to answer a repeated GET from a cache; a stale
      // sync file would silently undo whatever the other device just wrote.
      'Cache-Control': 'no-cache',
    },
    responseType: 'text',
  })

  console.info('[webdav] GET', { url, status: res.status })

  if (res.status === 404) return { status: 404, data: null, etag: null }
  if (res.status < 200 || res.status > 299) throwForStatus(res.status)

  return {
    status: res.status,
    data: res.data ?? null,
    etag: headerOf(res.headers, 'etag'),
  }
}

/**
 * Uploads a file, overwriting whatever is there.
 *
 * With `etag` the request carries `If-Match`, so the server refuses the write when the
 * file changed in the meantime (HTTP 412 → `conflict`). Pass the ETag that came back
 * from getFile(), verbatim, quotes and all.
 *
 * `ifNoneMatch: '*'` is the same guard for the very first write: it makes the server
 * refuse to overwrite a file that appeared between our GET (404) and our PUT.
 *
 * The returned ETag may be null: PUT responses are not required to carry one and not
 * every server sends it. A caller that needs the new ETag has to GET the file again.
 *
 * @param {object} config
 * @param {string} path appended to `config.path`; pass '' when `config.path` is the file
 * @param {string} content the body, already serialized
 * @param {{etag?: string|null, ifNoneMatch?: string|null, contentType?: string}} [options]
 * @returns {Promise<{status: number, etag: string|null}>}
 * @throws {Error} not_configured, dev_unsupported, unauthorized, forbidden, not_found
 *   (the folder does not exist), conflict (412 — someone else wrote first),
 *   server_error, network_error, request_failed
 */
export async function putFile(config, path, content, options = {}) {
  if (!isWebdavConfigured(config)) throw new Error('not_configured')

  const resolved = resolveWebdavConfig(config)
  const url = buildWebdavUrl(resolved, path)

  const headers = {
    Authorization: basicAuthHeader(resolved.username, resolved.password),
    'Content-Type': options.contentType || 'application/json; charset=utf-8',
  }
  if (options.etag) headers['If-Match'] = options.etag
  else if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch

  const res = await request({
    method: 'PUT',
    url,
    headers,
    // A string body is passed through as-is by both the web shim and the native bridge.
    // An object would be JSON.stringify()d for us — and a string that we stringify
    // ourselves would then be double-encoded, so the body is always a string here.
    data: typeof content === 'string' ? content : JSON.stringify(content),
    responseType: 'text',
  })

  console.info('[webdav] PUT', { url, status: res.status, ifMatch: Boolean(options.etag) })

  if (res.status < 200 || res.status > 299) throwForStatus(res.status)

  return { status: res.status, etag: headerOf(res.headers, 'etag') }
}

/**
 * Checks that the server answers and that the credentials are accepted.
 *
 * Without PROPFIND there is no way to ask "does this folder exist" — so we GET the file
 * we would sync. Anything that is not a 401/403 proves the credentials went through:
 *   • 2xx → the file is there (`exists: true`),
 *   • 404 → server and login are fine, the file has not been written yet,
 *   • 405/501 → the server refuses a GET on that resource but authenticated us.
 * A folder that does not exist is indistinguishable from a file that does not exist here;
 * it shows up on the first PUT as `not_found` (HTTP 409).
 *
 * @param {object} config
 * @param {string} [path] file to probe, relative to `config.path`
 * @returns {Promise<{ok: true, status: number, exists: boolean}>}
 * @throws {Error} not_configured, dev_unsupported, unauthorized, forbidden, server_error,
 *   network_error, request_failed
 */
export async function testConnection(config, path = '') {
  if (!isWebdavConfigured(config)) throw new Error('not_configured')

  const resolved = resolveWebdavConfig(config)
  const url = buildWebdavUrl(resolved, path)

  const res = await request({
    method: 'GET',
    url,
    headers: {
      Authorization: basicAuthHeader(resolved.username, resolved.password),
      Accept: '*/*',
      'Cache-Control': 'no-cache',
    },
    responseType: 'text',
  })

  console.info('[webdav] testConnection', { url, status: res.status })

  if (res.status === 401 || res.status === 403 || res.status >= 500) throwForStatus(res.status)

  // The server talked to us and did not ask for credentials → the login worked.
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { ok: true, status: res.status, exists: false }
  }
  if (res.status >= 200 && res.status <= 299) {
    return { ok: true, status: res.status, exists: true }
  }

  return throwForStatus(res.status)
}
