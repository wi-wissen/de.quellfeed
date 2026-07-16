import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getFile,
  putFile,
  testConnection,
  buildWebdavUrl,
  isWebdavConfigured,
  resolveWebdavConfig,
  getWebdavTransport,
} from '../src/utils/webdav.js'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) },
  CapacitorHttp: { request: vi.fn() },
}))

// A password that is neither ASCII nor short — btoa() throws on it unless it is UTF-8
// encoded first, and it is what every "password must not leak" assertion looks for.
const PASSWORD = 'Gehe1m-Paßwört-🔐'

const CONFIG = {
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/jd/',
  username: 'jd',
  password: PASSWORD,
  path: 'Quell Sync/quellfeed-sync.json',
}

const URL_ = 'https://cloud.example.com/remote.php/dav/files/jd/Quell%20Sync/quellfeed-sync.json'

function respond({ status = 200, data = '', headers = {} } = {}) {
  CapacitorHttp.request.mockResolvedValue({ status, data, headers })
}

/** The options object of the single CapacitorHttp.request() call. */
function sentRequest() {
  return CapacitorHttp.request.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  Capacitor.isNativePlatform.mockReturnValue(true)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('config', () => {
  it('knows when it can make a request', () => {
    expect(isWebdavConfigured(CONFIG)).toBe(true)
    expect(isWebdavConfigured({ ...CONFIG, password: '' })).toBe(false)
    expect(isWebdavConfigured({ ...CONFIG, baseUrl: '' })).toBe(false)
    expect(isWebdavConfigured(null)).toBe(false)
  })

  it('builds the url from the base url and the path, percent-encoding each segment', () => {
    expect(buildWebdavUrl(CONFIG)).toBe(URL_)
  })

  it('appends an extra path when one is given', () => {
    expect(buildWebdavUrl({ ...CONFIG, path: 'Quell' }, 'quellfeed-sync.json'))
      .toBe('https://cloud.example.com/remote.php/dav/files/jd/Quell/quellfeed-sync.json')
  })

  it('does not double-encode a path that is already encoded', () => {
    expect(buildWebdavUrl({ ...CONFIG, path: 'Quell%20Sync/a.json' }))
      .toContain('/Quell%20Sync/a.json')
  })

  it('strips credentials the user pasted into the url itself', () => {
    const config = resolveWebdavConfig({ ...CONFIG, baseUrl: `https://jd:${PASSWORD}@cloud.example.com/dav` })

    expect(config.baseUrl).toBe('https://cloud.example.com/dav')
    expect(config.baseUrl).not.toContain('Paßwört')
  })
})

describe('getFile', () => {
  it('sends Basic auth and reads the ETag', async () => {
    respond({ status: 200, data: '{"version":1}', headers: { ETag: '"abc123"' } })

    const res = await getFile(CONFIG)

    expect(sentRequest()).toMatchObject({ method: 'GET', url: URL_ })
    expect(sentRequest().headers.Authorization).toMatch(/^Basic /)
    expect(res).toEqual({ status: 200, data: '{"version":1}', etag: '"abc123"' })
  })

  it('finds the ETag whatever the server capitalized it', async () => {
    respond({ status: 200, data: '{}', headers: { etag: 'W/"weak-1"' } })

    expect((await getFile(CONFIG)).etag).toBe('W/"weak-1"')
  })

  it('reports a missing file as data, not as an error — that is the first sync', async () => {
    respond({ status: 404, data: 'Not Found' })

    await expect(getFile(CONFIG)).resolves.toEqual({ status: 404, data: null, etag: null })
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [500, 'server_error'],
    [503, 'server_error'],
    [418, 'request_failed'],
  ])('turns HTTP %i into %s', async (status, code) => {
    respond({ status })

    await expect(getFile(CONFIG)).rejects.toThrow(code)
  })

  it('throws not_configured instead of firing a request at nothing', async () => {
    await expect(getFile({ baseUrl: '', username: '', password: '' })).rejects.toThrow('not_configured')
    expect(CapacitorHttp.request).not.toHaveBeenCalled()
  })

  it('turns an unreachable server into network_error', async () => {
    CapacitorHttp.request.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getFile(CONFIG)).rejects.toThrow('network_error')
  })

  it('still recognizes the status when a platform rejects instead of resolving', async () => {
    CapacitorHttp.request.mockRejectedValue(Object.assign(new Error('HTTP 401'), { status: 401 }))

    await expect(getFile(CONFIG)).rejects.toThrow('unauthorized')
  })
})

describe('putFile', () => {
  it('sends the body as-is with a JSON content type', async () => {
    respond({ status: 204, headers: { ETag: '"v2"' } })

    const res = await putFile(CONFIG, '', '{"version":1}')

    expect(sentRequest()).toMatchObject({ method: 'PUT', url: URL_, data: '{"version":1}' })
    expect(sentRequest().headers['Content-Type']).toContain('application/json')
    expect(res).toEqual({ status: 204, etag: '"v2"' })
  })

  it('sends the ETag as If-Match when it is given one', async () => {
    respond({ status: 204 })

    await putFile(CONFIG, '', '{}', { etag: '"abc123"' })

    expect(sentRequest().headers['If-Match']).toBe('"abc123"')
    expect(sentRequest().headers).not.toHaveProperty('If-None-Match')
  })

  it('sends no If-Match when there is no ETag', async () => {
    respond({ status: 201 })

    await putFile(CONFIG, '', '{}')

    expect(sentRequest().headers).not.toHaveProperty('If-Match')
  })

  it('can guard the very first write with If-None-Match', async () => {
    respond({ status: 201 })

    await putFile(CONFIG, '', '{}', { ifNoneMatch: '*' })

    expect(sentRequest().headers['If-None-Match']).toBe('*')
  })

  it('turns 412 into a conflict — the other device wrote first', async () => {
    respond({ status: 412 })

    await expect(putFile(CONFIG, '', '{}', { etag: '"stale"' })).rejects.toThrow('conflict')
  })

  it('carries the status on the error, so a caller can tell a 412 apart', async () => {
    respond({ status: 412 })

    await expect(putFile(CONFIG, '', '{}')).rejects.toMatchObject({ message: 'conflict', status: 412 })
  })

  it('reports the missing folder (sabre/dav answers 409) as not_found', async () => {
    respond({ status: 409 })

    await expect(putFile(CONFIG, '', '{}')).rejects.toThrow('not_found')
  })

  it('accepts a PUT response without an ETag — not every server sends one', async () => {
    respond({ status: 204, headers: {} })

    await expect(putFile(CONFIG, '', '{}')).resolves.toEqual({ status: 204, etag: null })
  })
})

describe('testConnection', () => {
  it('is happy when the file is there', async () => {
    respond({ status: 200, data: '{}' })

    await expect(testConnection(CONFIG)).resolves.toEqual({ ok: true, status: 200, exists: true })
  })

  it('is happy when only the file is missing — nothing has been written yet', async () => {
    respond({ status: 404 })

    await expect(testConnection(CONFIG)).resolves.toEqual({ ok: true, status: 404, exists: false })
  })

  it('accepts a server that refuses a GET on that resource but did authenticate us', async () => {
    respond({ status: 405 })

    await expect(testConnection(CONFIG)).resolves.toMatchObject({ ok: true, exists: false })
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [500, 'server_error'],
  ])('reports HTTP %i as %s', async (status, code) => {
    respond({ status })

    await expect(testConnection(CONFIG)).rejects.toThrow(code)
  })

  it('refuses to test an unconfigured account', async () => {
    await expect(testConnection({ baseUrl: 'https://x.example' })).rejects.toThrow('not_configured')
  })
})

describe('Basic auth', () => {
  it('UTF-8 encodes the credentials before base64 — btoa() alone throws on an umlaut', async () => {
    respond({ status: 200, data: '{}' })

    await getFile(CONFIG)
    const header = sentRequest().headers.Authorization

    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.replace('Basic ', '')), c => c.charCodeAt(0)),
    )
    expect(decoded).toBe(`jd:${PASSWORD}`)
  })

  it('does not throw on a non-ASCII password (the btoa() trap)', async () => {
    respond({ status: 200, data: '{}' })

    await expect(getFile({ ...CONFIG, password: 'Ünïcödé-🔑' })).resolves.toBeTruthy()
  })
})

describe('the password never leaves the device in a log or an error', () => {
  const leaks = value => JSON.stringify(value ?? '').includes('Paßwört')

  it('keeps it out of every error message', async () => {
    for (const status of [401, 403, 404, 409, 412, 500, 502]) {
      respond({ status, data: `WebDAV error. Authorization: Basic jd:${PASSWORD}` })

      // getFile treats 404 as data; every other status throws.
      const error = await putFile(CONFIG, '', '{}').catch(e => e)

      expect(error).toBeInstanceOf(Error)
      expect(leaks(error.message)).toBe(false)
      expect(leaks(error.stack)).toBe(false)
    }
  })

  it('keeps it out of a network error, even when the transport echoes the request', async () => {
    CapacitorHttp.request.mockRejectedValue(new Error(`connect failed for jd:${PASSWORD}@cloud.example.com`))

    const error = await getFile(CONFIG).catch(e => e)

    expect(error.message).toBe('network_error')
    expect(leaks(error.message)).toBe(false)
  })

  it('keeps it out of every log line', async () => {
    respond({ status: 200, data: '{}', headers: { ETag: '"v1"' } })

    await getFile(CONFIG)
    await putFile(CONFIG, '', '{}', { etag: '"v1"' })
    CapacitorHttp.request.mockRejectedValue(new Error(`boom ${PASSWORD}`))
    await getFile(CONFIG).catch(() => {})

    const logged = [...console.info.mock.calls, ...console.error.mock.calls]
    expect(logged.length).toBeGreaterThan(0)
    for (const call of logged) {
      expect(leaks(call)).toBe(false)
    }
  })

  it('redacts it when the config itself is stringified', () => {
    const config = resolveWebdavConfig(CONFIG)

    expect(leaks(config)).toBe(false)
    expect(JSON.parse(JSON.stringify(config)).password).toBe('[redacted]')
    // …while the value itself is of course still usable.
    expect(config.password).toBe(PASSWORD)
  })
})

describe('the browser dev build goes through the Vite proxy', () => {
  // A direct call would die on CORS — no WebDAV server sends
  // Access-Control-Allow-Origin for an authenticated PUT. The /__dav middleware in
  // vite.config.js passes the body, the Authorization header and If-Match through,
  // and hands the ETag back, which is what keeps conflict detection alive here.
  it('routes through /__dav instead of CapacitorHttp, carrying auth and If-Match', async () => {
    Capacitor.isNativePlatform.mockReturnValue(false)
    expect(getWebdavTransport()).toBe('proxy')

    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () => '{}',
      headers: new Headers({ etag: '"abc"' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await putFile(CONFIG, '', '{}', { etag: '"abc"' })

    expect(CapacitorHttp.request).not.toHaveBeenCalled()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/__dav?url=')
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toMatch(/^Basic /)
    expect(init.headers['If-Match']).toBe('"abc"')
    expect(init.body).toBe('{}')
    expect(result.etag).toBe('"abc"')

    vi.unstubAllGlobals()
  })

  it('reports network_error when the proxy itself is unreachable', async () => {
    Capacitor.isNativePlatform.mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(getFile(CONFIG)).rejects.toThrow('network_error')

    vi.unstubAllGlobals()
  })

  it('uses CapacitorHttp in the native build', async () => {
    respond({ status: 200, data: '{}' })

    expect(getWebdavTransport()).toBe('native')
    await getFile(CONFIG)

    expect(CapacitorHttp.request).toHaveBeenCalledTimes(1)
  })
})
