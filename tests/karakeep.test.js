import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KARAKEEP_SETTINGS,
  deleteFromKarakeep,
  isKarakeepConfigured,
  pullFromKarakeep,
  pushToKarakeep,
  resolveKarakeepConfig,
  syncWithKarakeep,
  testKarakeepConnection,
  urlKey,
} from '../src/utils/karakeep.js'

const API_KEY = 'ak1_super_secret_key_1234567890'

const SETTINGS = {
  baseUrl: 'https://karakeep.example.com',
  apiKey: API_KEY,
  favouritesOnly: true,
  enabled: true,
  lastSync: null,
}

// Deterministic ids, so a pulled article can be asserted on.
let idCounter = 0
const newId = () => `id-${++idCounter}`

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

/** A KaraKeep bookmark as the API returns it: url + crawler fields nested under `content`. */
function bookmark(overrides = {}) {
  const { content, ...rest } = overrides
  return {
    id: 'bm-1',
    createdAt: '2026-06-01T10:00:00.000Z',
    // The server stamps this on every PATCH — the archive LWW compares against it.
    modifiedAt: '2026-06-01T10:00:00.000Z',
    title: 'Der Titel',
    note: 'Die Beschreibung',
    archived: false,
    favourited: true,
    source: 'rss',
    content: {
      type: 'link',
      url: 'https://example.com/artikel',
      title: 'Crawler-Titel',
      description: 'Crawler-Beschreibung',
      imageUrl: 'https://example.com/bild.jpg',
      ...content,
    },
    ...rest,
  }
}

function article(overrides = {}) {
  return {
    id: 'local-1',
    feedId: null,
    source: 'example.com',
    url: 'https://example.com/artikel',
    title: 'Der Titel',
    description: 'Die Beschreibung',
    image: null,
    isRead: false,
    isSaved: true,
    isArchived: false,
    publishedAt: '2026-06-01T10:00:00.000Z',
    cachedHtml: null,
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * A POST that really created the bookmark. The live server answers 201 with
 * `alreadyExists: false`; the same route answering 200 + `alreadyExists: true` is a no-op
 * that dropped the whole body, which is a different case entirely.
 */
const CREATED = jsonResponse({ id: 'bm-new', alreadyExists: false }, 201)

/** An entry of the remoteIndex syncWithKarakeep() builds from the listing. */
function indexed(overrides = {}) {
  return { id: 'bm-1', archived: false, favourited: true, ...overrides }
}

function indexOf(entry, url = 'https://example.com/artikel') {
  return new Map([[urlKey(url), entry]])
}

/**
 * A fetch mock that answers by (method, path). Every entry is a function of the URL, so a
 * test can assert on the query string too.
 */
function mockApi(routes) {
  return vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET'
    const parsed = new URL(url)
    const key = `${method} ${parsed.pathname}`

    const route = routes[key]
    if (!route) throw new Error(`unexpected request: ${key}`)

    const body = init.body ? JSON.parse(init.body) : undefined
    const result = typeof route === 'function' ? await route(parsed, body) : route
    return result ?? jsonResponse({})
  })
}

function callsTo(fetchMock, method, pathname) {
  return fetchMock.mock.calls.filter(([url, init = {}]) =>
    (init.method || 'GET') === method && new URL(url).pathname === pathname)
}

function bodyOf(call) {
  return JSON.parse(call[1].body)
}

beforeEach(() => {
  idCounter = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('config', () => {
  it('defaults to a disabled, favourites-only account', () => {
    expect(DEFAULT_KARAKEEP_SETTINGS).toEqual({
      baseUrl: '',
      apiKey: '',
      favouritesOnly: true,
      enabled: false,
      lastSync: null,
    })
  })

  it('knows when a request could be made', () => {
    expect(isKarakeepConfigured(SETTINGS)).toBe(true)
    expect(isKarakeepConfigured({ ...SETTINGS, apiKey: '' })).toBe(false)
    expect(isKarakeepConfigured({ ...SETTINGS, baseUrl: '' })).toBe(false)
    expect(isKarakeepConfigured(null)).toBe(false)
  })

  it('strips a trailing slash and a pasted /api/v1 from the address', () => {
    expect(resolveKarakeepConfig({ baseUrl: 'https://k.example.com/' }).baseUrl)
      .toBe('https://k.example.com')
    expect(resolveKarakeepConfig({ baseUrl: 'https://k.example.com/api/v1' }).baseUrl)
      .toBe('https://k.example.com')
    expect(resolveKarakeepConfig({ baseUrl: 'https://k.example.com/api/v1/' }).baseUrl)
      .toBe('https://k.example.com')
  })

  it('strips credentials pasted into the address itself', () => {
    const config = resolveKarakeepConfig({ baseUrl: `https://user:${API_KEY}@k.example.com` })

    expect(config.baseUrl).toBe('https://k.example.com')
    expect(config.baseUrl).not.toContain(API_KEY)
  })

  it('redacts the api key when the config is stringified', () => {
    const json = JSON.stringify(resolveKarakeepConfig(SETTINGS))

    expect(json).not.toContain(API_KEY)
    expect(json).toContain('[redacted]')
    // …while the value itself is of course still usable.
    expect(resolveKarakeepConfig(SETTINGS).apiKey).toBe(API_KEY)
  })
})

describe('urlKey — identity is the url, not the id', () => {
  it('ignores the fragment, a trailing slash, www. and the case of the host', () => {
    const key = urlKey('https://example.com/artikel')

    expect(urlKey('https://example.com/artikel/')).toBe(key)
    expect(urlKey('https://example.com/artikel#top')).toBe(key)
    expect(urlKey('https://www.example.com/artikel')).toBe(key)
    expect(urlKey('https://EXAMPLE.com/artikel')).toBe(key)
  })

  it('keeps the query — it is part of the page', () => {
    expect(urlKey('https://example.com/a?p=1')).not.toBe(urlKey('https://example.com/a'))
  })
})

describe('testKarakeepConnection', () => {
  it('sends the bearer token and asks for a single bookmark', async () => {
    const fetchMock = mockApi({ 'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [], nextCursor: null }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(testKarakeepConnection(SETTINGS)).resolves.toEqual({ ok: true, status: 200 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('https://karakeep.example.com/api/v1/bookmarks')
    expect(new URL(url).searchParams.get('limit')).toBe('1')
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('never sends credentials — the CORS wildcard would reject them', async () => {
    const fetchMock = mockApi({ 'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    await testKarakeepConnection(SETTINGS)

    expect(fetchMock.mock.calls[0][1].credentials).toBeUndefined()
  })
})

describe('error codes', () => {
  it('throws not_configured without a key — and fires no request at all', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const blind = { ...SETTINGS, apiKey: '' }

    await expect(testKarakeepConnection(blind)).rejects.toThrow('not_configured')
    await expect(pullFromKarakeep(blind)).rejects.toThrow('not_configured')
    await expect(pushToKarakeep([article()], blind)).rejects.toThrow('not_configured')
    await expect(syncWithKarakeep([article()], blind)).rejects.toThrow('not_configured')
    await expect(deleteFromKarakeep('https://example.com/a', blind)).rejects.toThrow('not_configured')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws not_configured without an address, too', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(pullFromKarakeep({ ...SETTINGS, baseUrl: '' })).rejects.toThrow('not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'request_failed'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ code: 'boom', message: 'no' }, status),
    }))

    await expect(pullFromKarakeep(SETTINGS)).rejects.toThrow(code)
  })

  it('carries the status on the error', async () => {
    vi.stubGlobal('fetch', mockApi({ 'GET /api/v1/bookmarks': jsonResponse({}, 429) }))

    await expect(pullFromKarakeep(SETTINGS)).rejects.toMatchObject({ message: 'rate_limited', status: 429 })
  })

  it('survives a 401 that answers text/plain instead of json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 401,
      ok: false,
      text: async () => 'Unauthorized',
    })))

    await expect(pullFromKarakeep(SETTINGS)).rejects.toThrow('unauthorized')
  })

  it('maps an unreachable server to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(pullFromKarakeep(SETTINGS)).rejects.toThrow('network_error')
  })

  it('maps an aborted request to aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    }))

    await expect(pullFromKarakeep(SETTINGS, { signal: controller.signal })).rejects.toThrow('aborted')
  })
})

describe('push', () => {
  it('creates a bookmark the server does not have yet', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article()], SETTINGS)

    expect(result).toEqual({ pushed: 1, skipped: 0 })

    const body = bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0])
    expect(body).toMatchObject({
      type: 'link',
      url: 'https://example.com/artikel',
      title: 'Der Titel',
      note: 'Die Beschreibung',
      archived: false,
      favourited: true,
      createdAt: '2026-06-01T10:00:00.000Z',
      source: 'rss',
    })
  })

  // The single most important test in this file: a sync that duplicates its own output on
  // every run is worse than no sync at all.
  it('creates NO duplicate when the url is already on the server', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: 'bm-1' }),
      'POST /api/v1/bookmarks': CREATED,
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({ id: 'bm-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article()], SETTINGS)

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
  })

  it('asks check-url with the article url', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: 'bm-1' }),
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article()], SETTINGS)

    const [url] = callsTo(fetchMock, 'GET', '/api/v1/bookmarks/check-url')[0]
    expect(new URL(url).searchParams.get('url')).toBe('https://example.com/artikel')
  })

  it('recognizes the same article under a trailing slash, a fragment and www.', async () => {
    const fetchMock = mockApi({ 'POST /api/v1/bookmarks': CREATED })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep(
      [article({ url: 'https://www.example.com/artikel/#lesen' })],
      SETTINGS,
      { remoteIndex: indexOf(indexed()) },
    )

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  it('ignores articles that are not saved and urls it cannot use', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([
      article({ isSaved: false }),
      article({ url: 'javascript:alert(1)' }),
      article({ url: '' }),
    ], SETTINGS)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ pushed: 0, skipped: 0 })
  })

  it('never uploads cachedHtml or the paid-for summary', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep(
      [article({ cachedHtml: '<p>Megabytes</p>', summary: 'Die teure KI-Zusammenfassung.' })],
      SETTINGS,
    )

    const body = bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0])
    expect(body).not.toHaveProperty('cachedHtml')
    expect(body).not.toHaveProperty('summary')
    expect(JSON.stringify(body)).not.toContain('Megabytes')
    expect(JSON.stringify(body)).not.toContain('teure')
  })

  it('sends the crawler-proof top-level fields, not content.*', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article()], SETTINGS)

    const body = bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0])
    expect(body.title).toBe('Der Titel')
    expect(body.note).toBe('Die Beschreibung')
    expect(body).not.toHaveProperty('content')
  })

  it('sends the source enum "rss", not our publication name', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article({ source: 'heise.de' })], SETTINGS)

    expect(bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0]).source).toBe('rss')
  })

  it('updates the archive state of a bookmark that is already there, without re-creating it', async () => {
    const fetchMock = mockApi({
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({ id: 'bm-1' }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isArchived: true })], SETTINGS, {
      remoteIndex: indexOf(indexed({ archived: false })),
    })

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0])).toEqual({ archived: true })
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('restores: un-archiving here PATCHes archived back to false over there', async () => {
    const fetchMock = mockApi({ 'PATCH /api/v1/bookmarks/bm-1': jsonResponse({ id: 'bm-1' }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isArchived: false })], SETTINGS, {
      remoteIndex: indexOf(indexed({ archived: true })),
    })

    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0])).toEqual({ archived: false })
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('does not touch a bookmark that already agrees', async () => {
    const fetchMock = mockApi({})
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isArchived: true })], SETTINGS, {
      remoteIndex: indexOf(indexed({ archived: true, favourited: true })),
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  // The regression that pins the remap: `archived` used to carry isRead. Reading an
  // article must never archive its bookmark again.
  it('does NOT write isRead into archived — the read state is not synced at all', async () => {
    const fetchMock = mockApi({})
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isRead: true, isArchived: false })], SETTINGS, {
      remoteIndex: indexOf(indexed({ archived: false, favourited: true })),
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  it('never writes the title, the note or createdAt back onto an existing bookmark', async () => {
    const fetchMock = mockApi({ 'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}) })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep(
      [article({ isArchived: true, title: 'Lokal umbenannt', description: 'Lokal umgeschrieben' })],
      SETTINGS,
      { remoteIndex: indexOf(indexed({ archived: false })) },
    )

    // The user may have curated this bookmark in KaraKeep. Only the two flags are ours.
    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0])).toEqual({ archived: true })
  })

  // ── What the live server actually does ────────────────────────────────────
  // POST /bookmarks dedupes on a byte-identical url and answers 200 { alreadyExists: true }
  // — but it is a pure no-op: every field of the body is dropped, including the flags. Only
  // a PATCH can ever change a bookmark that is already there.

  it('favourites a bookmark that is on the server but not in the favourites', async () => {
    // The regression. With favouritesOnly the listing — and therefore the index — holds only
    // the favourites, so a link the user already had in KaraKeep as a plain bookmark is a
    // miss. Re-POSTing it changes nothing on the server, so it would never become a
    // favourite, never enter the next listing, and be re-POSTed on every sync forever.
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: 'bm-1' }),
      'POST /api/v1/bookmarks': CREATED,
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({ id: 'bm-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article()], SETTINGS, { remoteIndex: new Map() })

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0]))
      .toEqual({ archived: false, favourited: true })
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('patches the flags an indexed bookmark disagrees on, favourited included', async () => {
    const fetchMock = mockApi({ 'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}) })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article({ isArchived: true })], SETTINGS, {
      remoteIndex: indexOf(indexed({ archived: false, favourited: false })),
    })

    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0]))
      .toEqual({ archived: true, favourited: true })
  })

  it('patches the flags when a POST turns out to be a no-op on an existing bookmark', async () => {
    // The race: another device created the bookmark between the listing and the POST. The
    // server answers 200 and drops our body — so the flags must still be PATCHed.
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': jsonResponse(
        { id: 'bm-1', archived: false, favourited: false, alreadyExists: true },
        200,
      ),
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isArchived: true })], SETTINGS)

    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0]))
      .toEqual({ archived: true, favourited: true })
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('does not patch after a POST that really did create the bookmark', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': CREATED,
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pushToKarakeep([article({ isArchived: true })], SETTINGS)

    expect(fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'PATCH')).toHaveLength(0)
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('falls back on the other spelling of the host — check-url does not fold www.', async () => {
    // check-url normalizes the fragment, a trailing slash and the case of the host, and
    // stops there: `www.example.com/x` does not find a bookmark stored as `example.com/x`.
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': parsed =>
        jsonResponse({
          bookmarkId: parsed.searchParams.get('url') === 'https://example.com/artikel' ? 'bm-1' : null,
        }),
      'POST /api/v1/bookmarks': CREATED,
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article({ url: 'https://www.example.com/artikel' })], SETTINGS)

    // No second bookmark: it found the one that is there under the other spelling.
    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(callsTo(fetchMock, 'GET', '/api/v1/bookmarks/check-url')).toHaveLength(2)
  })

  it('never writes favourited when favouritesOnly is off', async () => {
    // With the filter off the whole library is pulled, so every bookmark becomes a saved
    // article. Writing isSaved back would favourite the user's entire library.
    const fetchMock = mockApi({ 'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}) })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article({ isArchived: true })], { ...SETTINGS, favouritesOnly: false }, {
      remoteIndex: indexOf(indexed({ archived: false, favourited: false })),
    })

    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0])).toEqual({ archived: true })
  })
})

describe('pull', () => {
  it('maps a bookmark into the store article shape', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark()], nextCursor: null }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles).toEqual([{
      id: 'id-1',
      feedId: null,
      source: 'example.com',
      url: 'https://example.com/artikel',
      title: 'Der Titel',
      description: 'Die Beschreibung',
      image: 'https://example.com/bild.jpg',
      isRead: false,
      isSaved: true,
      isArchived: false,
      publishedAt: '2026-06-01T10:00:00.000Z',
      cachedHtml: null,
      updatedAt: '2026-06-01T10:00:00.000Z',
    }])
  })

  it('reads `archived` as the archive — and NOT as the read state', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark({ archived: true })], nextCursor: null }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(true)
    expect(articles[0].isSaved).toBe(true)
    expect(articles[0].isRead).toBe(false)
  })

  it('asks only for the favourites by default — the saved list is not the whole library', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [], nextCursor: null }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pullFromKarakeep(SETTINGS)

    const [url] = fetchMock.mock.calls[0]
    expect(new URL(url).searchParams.get('favourited')).toBe('true')
    expect(new URL(url).searchParams.get('includeContent')).toBe('false')
  })

  it('pulls the whole library when favouritesOnly is off', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [], nextCursor: null }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pullFromKarakeep({ ...SETTINGS, favouritesOnly: false })

    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.has('favourited')).toBe(false)
  })

  it('prefers the user-owned top-level fields over the crawler-owned content.*', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark()], nextCursor: null }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles[0].title).toBe('Der Titel')
    expect(articles[0].description).toBe('Die Beschreibung')
  })

  it('falls back on content.* for a bookmark created in KaraKeep itself', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({
        bookmarks: [bookmark({ title: null, note: null })],
        nextCursor: null,
      }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles[0].title).toBe('Crawler-Titel')
    expect(articles[0].description).toBe('Crawler-Beschreibung')
  })

  it('drops bookmarks that have no url — a text note is nothing a reader can open', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({
        bookmarks: [
          bookmark(),
          { id: 'bm-2', createdAt: '2026-06-02T10:00:00.000Z', content: { type: 'text', text: 'Notiz' } },
        ],
        nextCursor: null,
      }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles).toHaveLength(1)
    expect(articles[0].url).toBe('https://example.com/artikel')
  })
})

describe('round-trip of the field mapping', () => {
  it('isArchived ↔ archived, isSaved ↔ favourited, publishedAt ↔ createdAt', async () => {
    const source = article({
      isArchived: true,
      isSaved: true,
      publishedAt: '2026-05-04T08:30:00.000Z',
    })

    // Out…
    const postMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': jsonResponse({}, 201),
    })
    vi.stubGlobal('fetch', postMock)
    await pushToKarakeep([source], SETTINGS)

    const sent = bodyOf(callsTo(postMock, 'POST', '/api/v1/bookmarks')[0])
    expect(sent.archived).toBe(true)
    expect(sent.favourited).toBe(true)
    expect(sent.createdAt).toBe('2026-05-04T08:30:00.000Z')

    // …and back in. The server echoes what we wrote, nested the way it stores it.
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({
        bookmarks: [bookmark({
          title: sent.title,
          note: sent.note,
          archived: sent.archived,
          favourited: sent.favourited,
          createdAt: sent.createdAt,
          content: { url: sent.url, imageUrl: null },
        })],
        nextCursor: null,
      }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(articles[0]).toMatchObject({
      url: source.url,
      title: source.title,
      description: source.description,
      isArchived: true,
      isSaved: true,
      publishedAt: '2026-05-04T08:30:00.000Z',
    })
  })

  it('keeps the british spelling — there is no `favorited` in the wire format', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': jsonResponse({}, 201),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pushToKarakeep([article()], SETTINGS)

    const body = bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0])
    expect(body).toHaveProperty('favourited')
    expect(body).not.toHaveProperty('favorited')
  })
})

describe('pagination', () => {
  it('collects every page of the cursor loop', async () => {
    const pages = {
      '': { bookmarks: [bookmark({ id: 'bm-1', content: { url: 'https://example.com/1' } })], nextCursor: 'c1' },
      c1: { bookmarks: [bookmark({ id: 'bm-2', content: { url: 'https://example.com/2' } })], nextCursor: 'c2' },
      c2: { bookmarks: [bookmark({ id: 'bm-3', content: { url: 'https://example.com/3' } })], nextCursor: null },
    }

    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': url => jsonResponse(pages[url.searchParams.get('cursor') || '']),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(articles.map(a => a.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
  })

  it('asks for at most 100 per page — the server rejects more with a 400', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [], nextCursor: null }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pullFromKarakeep(SETTINGS)

    expect(Number(new URL(fetchMock.mock.calls[0][0]).searchParams.get('limit'))).toBeLessThanOrEqual(100)
  })

  it('terminates on a broken server that keeps handing back the same cursor', async () => {
    // Without the guard this is an infinite loop that pins the CPU and never resolves.
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark()], nextCursor: 'always-the-same' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })

    // Page one, then page two comes back with a cursor we have already followed → stop.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // …and the bookmark it served us twice is one article, not two.
    expect(articles).toHaveLength(1)
  })

  it('deduplicates by url — the same link twice is one article', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({
        bookmarks: [
          bookmark({ id: 'bm-1' }),
          bookmark({ id: 'bm-2', content: { url: 'https://www.example.com/artikel/' } }),
        ],
        nextCursor: null,
      }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })
    expect(articles).toHaveLength(1)
  })

  it('stops at the page cap even when every cursor is new', async () => {
    let n = 0
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': () => jsonResponse({ bookmarks: [], nextCursor: `cursor-${++n}` }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await pullFromKarakeep(SETTINGS)

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(200)
  })

  it('survives a page without a nextCursor field at all', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark()] }),
    }))

    const { articles } = await pullFromKarakeep(SETTINGS, { newId })
    expect(articles).toHaveLength(1)
  })
})

describe('syncWithKarakeep', () => {
  const listOnce = bookmarks => mockApi({
    'GET /api/v1/bookmarks': jsonResponse({ bookmarks, nextCursor: null }),
    'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
    'POST /api/v1/bookmarks': CREATED,
    'PATCH /api/v1/bookmarks/bm-1': jsonResponse({}),
  })

  it('pulls what is new, pushes what is missing, and returns the full list', async () => {
    const fetchMock = listOnce([
      bookmark({ id: 'bm-9', content: { url: 'https://example.com/nur-remote' } }),
    ])
    vi.stubGlobal('fetch', fetchMock)

    const local = [article({ id: 'local-1', url: 'https://example.com/nur-lokal' })]

    const result = await syncWithKarakeep(local, SETTINGS, { newId })

    expect(result.pulled).toBe(1)
    expect(result.pushed).toBe(1)
    expect(result.articles.map(a => a.url).sort()).toEqual([
      'https://example.com/nur-lokal',
      'https://example.com/nur-remote',
    ])

    // The one push is the local-only article, and it is a creation.
    expect(bodyOf(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')[0]).url)
      .toBe('https://example.com/nur-lokal')
  })

  it('creates no duplicate for an article that is on both sides', async () => {
    const fetchMock = listOnce([bookmark()])
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncWithKarakeep([article()], SETTINGS, { newId })

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(result.articles).toHaveLength(1)
    expect(result.pushed).toBe(0)
  })

  it('spends no check-url request — the listing already told it everything', async () => {
    const fetchMock = listOnce([bookmark()])
    vi.stubGlobal('fetch', fetchMock)

    await syncWithKarakeep([article()], SETTINGS, { newId })

    expect(callsTo(fetchMock, 'GET', '/api/v1/bookmarks/check-url')).toHaveLength(0)
  })

  it('favourites a saved article the server holds as a plain bookmark, instead of re-POSTing it forever', async () => {
    // With favouritesOnly the listing holds only the favourites, so this bookmark is not in
    // it. A POST would be a no-op on the server (it drops the body), the bookmark would stay
    // unfavourited, stay out of the next listing, and be POSTed again on every single sync.
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [], nextCursor: null }),
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: 'bm-1' }),
      'POST /api/v1/bookmarks': CREATED,
      'PATCH /api/v1/bookmarks/bm-1': jsonResponse({ id: 'bm-1' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { pushed } = await syncWithKarakeep([article()], SETTINGS, { newId })

    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0]))
      .toEqual({ archived: false, favourited: true })
    expect(pushed).toBe(1)
  })

  it('converges: once the bookmark is a favourite the next sync writes nothing', async () => {
    const fetchMock = listOnce([bookmark()])
    vi.stubGlobal('fetch', fetchMock)

    const { pushed } = await syncWithKarakeep([article()], SETTINGS, { newId })

    expect(pushed).toBe(0)
    expect(fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'PATCH')).toHaveLength(0)
    expect(callsTo(fetchMock, 'POST', '/api/v1/bookmarks')).toHaveLength(0)
  })

  it('never overwrites the local cachedHtml or summary on a pull', async () => {
    vi.stubGlobal('fetch', listOnce([bookmark({ title: 'Serverseitig anders', note: 'Auch anders' })]))

    const local = article({
      cachedHtml: '<p>Der gecachte Artikel</p>',
      summary: 'Die teuer bezahlte Zusammenfassung.',
    })

    const { articles } = await syncWithKarakeep([local], SETTINGS, { newId })

    expect(articles[0].cachedHtml).toBe('<p>Der gecachte Artikel</p>')
    expect(articles[0].summary).toBe('Die teuer bezahlte Zusammenfassung.')
  })

  it('keeps the local id — nobody else\'s uuid ever enters this device', async () => {
    vi.stubGlobal('fetch', listOnce([bookmark()]))

    const { articles } = await syncWithKarakeep([article({ id: 'local-1' })], SETTINGS, { newId })

    expect(articles[0].id).toBe('local-1')
  })

  it('does not downgrade a known publishedAt to the import date', async () => {
    // The feed said the article was published in March; KaraKeep only knows when it was
    // bookmarked. The better date wins.
    vi.stubGlobal('fetch', listOnce([bookmark({ createdAt: '2026-06-01T10:00:00.000Z' })]))

    const local = article({ publishedAt: '2026-03-15T06:00:00.000Z' })
    const { articles } = await syncWithKarakeep([local], SETTINGS, { newId })

    expect(articles[0].publishedAt).toBe('2026-03-15T06:00:00.000Z')
  })

  it('archives an article when the server has its bookmark archived', async () => {
    vi.stubGlobal('fetch', listOnce([bookmark({ archived: true })]))

    const { articles, pulled } = await syncWithKarakeep([article({ isArchived: false })], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(true)
    expect(articles[0].isSaved).toBe(true)
    expect(pulled).toBe(1)
  })

  it('restore travels: a local un-archive NEWER than the server state patches it back', async () => {
    // Measured live before the fix: a plain OR re-imported the server's archived:true on
    // the very sync that was supposed to clear it — restore never reached the server.
    const fetchMock = listOnce([bookmark({ archived: true, modifiedAt: '2026-06-02T10:00:00.000Z' })])
    vi.stubGlobal('fetch', fetchMock)

    const local = article({ isArchived: false, updatedAt: '2026-06-03T10:00:00.000Z' })
    const { articles } = await syncWithKarakeep([local], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(false)
    expect(bodyOf(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')[0])).toEqual({ archived: false })
  })

  it('a NEWER archive on the server beats an older local state', async () => {
    const fetchMock = listOnce([bookmark({ archived: true, modifiedAt: '2026-06-05T10:00:00.000Z' })])
    vi.stubGlobal('fetch', fetchMock)

    const local = article({ isArchived: false, updatedAt: '2026-06-03T10:00:00.000Z' })
    const { articles } = await syncWithKarakeep([local], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(true)
    expect(callsTo(fetchMock, 'PATCH', '/api/v1/bookmarks/bm-1')).toHaveLength(0)
  })

  it('leaves the local read state alone — KaraKeep carries no read flag anymore', async () => {
    // The regression the remap could cause: `archived` used to be isRead, and a pull that
    // still read it that way would mark a read article unread (or the reverse).
    vi.stubGlobal('fetch', listOnce([bookmark({ archived: false })]))

    const { articles } = await syncWithKarakeep([article({ isRead: true })], SETTINGS, { newId })

    expect(articles[0].isRead).toBe(true)
    expect(articles[0].isArchived).toBe(false)
  })

  it('does not turn a feed article into a second, saved copy of itself', async () => {
    // The user bookmarked an article in KaraKeep that this device already has from a feed.
    vi.stubGlobal('fetch', listOnce([bookmark()]))

    const feedArticle = article({ id: 'local-1', feedId: 'feed-1', isSaved: false })
    const { articles } = await syncWithKarakeep([feedArticle], SETTINGS, { newId })

    expect(articles).toHaveLength(1)
    expect(articles[0].id).toBe('local-1')
    expect(articles[0].feedId).toBe('feed-1')
    expect(articles[0].isSaved).toBe(true)
  })

  it('does not delete a local article that is no longer on the server', async () => {
    // Absence is not evidence: a filter or a half-read page must never wipe the library.
    vi.stubGlobal('fetch', listOnce([]))

    const { articles } = await syncWithKarakeep([article()], SETTINGS, { newId })

    expect(articles).toHaveLength(1)
  })
})

describe('deleteFromKarakeep', () => {
  it('deletes the bookmark behind a url', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: 'bm-1' }),
      'DELETE /api/v1/bookmarks/bm-1': jsonResponse(undefined, 204),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteFromKarakeep('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: true })
    expect(callsTo(fetchMock, 'DELETE', '/api/v1/bookmarks/bm-1')).toHaveLength(1)
  })

  it('is a no-op when there is nothing to delete', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteFromKarakeep('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: false })
  })
})

describe('the api key never leaves the device in a log or an error', () => {
  const leaks = value => JSON.stringify(value ?? '').includes(API_KEY)

  it('keeps it out of every error message, even from a server that echoes the request', async () => {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      vi.stubGlobal('fetch', mockApi({
        'GET /api/v1/bookmarks': jsonResponse(
          { code: 'nope', message: `Invalid key: ${API_KEY}`, request: { headers: { Authorization: `Bearer ${API_KEY}` } } },
          status,
        ),
      }))

      const error = await pullFromKarakeep(SETTINGS).catch(e => e)

      expect(error).toBeInstanceOf(Error)
      expect(leaks(error.message)).toBe(false)
      expect(leaks(error.stack)).toBe(false)
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(API_KEY)
    }
  })

  it('keeps it out of a network error, even when the transport echoes the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`connect failed, Authorization: Bearer ${API_KEY}`)
    }))

    const error = await pullFromKarakeep(SETTINGS).catch(e => e)

    expect(error.message).toBe('network_error')
    expect(leaks(error.message)).toBe(false)
  })

  it('keeps it out of every log line', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /api/v1/bookmarks': jsonResponse({ bookmarks: [bookmark()], nextCursor: null }),
      'GET /api/v1/bookmarks/check-url': jsonResponse({ bookmarkId: null }),
      'POST /api/v1/bookmarks': jsonResponse({}, 201),
    }))

    await pullFromKarakeep(SETTINGS, { newId })
    await pushToKarakeep([article({ url: 'https://example.com/neu' })], SETTINGS)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`boom ${API_KEY}`) }))
    await pullFromKarakeep(SETTINGS).catch(() => {})

    const logged = [
      ...console.info.mock.calls,
      ...console.warn.mock.calls,
      ...console.error.mock.calls,
    ]
    expect(logged.length).toBeGreaterThan(0)
    for (const call of logged) {
      expect(leaks(call)).toBe(false)
    }
  })
})
