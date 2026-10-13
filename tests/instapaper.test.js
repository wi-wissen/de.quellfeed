import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INSTAPAPER_SETTINGS,
  deleteFromInstapaper,
  isInstapaperConfigured,
  pushToInstapaper,
  resolveInstapaperConfig,
  syncWithInstapaper,
  testInstapaperConnection,
  urlKey,
} from '../src/utils/instapaper.js'

const TOKEN = 'ip_super_secret_token_1234567890'
const SETTINGS = { accessToken: TOKEN, enabled: true, lastSync: null }

let idCounter = 0
const newId = () => `id-${++idCounter}`

function jsonResponse(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
}

/** An Instapaper v2 bookmark as the API returns it. */
function bookmark(overrides = {}) {
  return {
    id: 1,
    url: 'https://example.com/artikel',
    title: 'Der Titel',
    description: 'Die Beschreibung',
    image: 'https://example.com/bild.jpg',
    progress: { percentage: 0, timestamp: 0 },
    liked: false,
    archived: false,
    time: 1780308000, // 2026-06-01T10:00:00Z
    pubtime: null,
    author: null,
    folder_id: null,
    tags: [],
    private_source: null,
    category: 0,
    ...overrides,
  }
}

function article(overrides = {}) {
  return {
    id: 'local-1', feedId: null, source: 'example.com', url: 'https://example.com/artikel',
    title: 'Der Titel', description: 'Die Beschreibung', image: null,
    isRead: false, isSaved: true, isArchived: false,
    publishedAt: '2026-06-01T10:00:00.000Z', cachedHtml: null, updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

/** Answers by (method, API path). The dev transport wraps the URL in /__dav?url=… */
function mockApi(routes) {
  return vi.fn(async (proxied, init = {}) => {
    const target = new URL(new URL(proxied, 'http://localhost').searchParams.get('url'))
    const key = `${init.method || 'GET'} ${target.pathname.replace('/api/2', '')}`
    const route = routes[key]
    if (!route) throw new Error(`unexpected request: ${key}`)
    const body = init.body ? JSON.parse(init.body) : undefined
    return (typeof route === 'function' ? await route(target, body, init) : route) ?? jsonResponse({})
  })
}

const callsTo = (fetchMock, method, path) =>
  fetchMock.mock.calls.filter(([url, init = {}]) =>
    (init.method || 'GET') === method
    && new URL(new URL(url, 'http://localhost').searchParams.get('url')).pathname === `/api/2${path}`)

const bodyOf = call => JSON.parse(call[1].body)

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
  it('defaults to a disabled account without a token', () => {
    expect(DEFAULT_INSTAPAPER_SETTINGS).toEqual({ accessToken: '', enabled: false, lastSync: null })
    expect(isInstapaperConfigured(DEFAULT_INSTAPAPER_SETTINGS)).toBe(false)
  })

  it('strips a pasted "Bearer " prefix and whitespace', () => {
    expect(resolveInstapaperConfig({ accessToken: '  Bearer abc123\n' }).accessToken).toBe('abc123')
  })

  it('redacts the token when serialized', () => {
    expect(JSON.stringify(resolveInstapaperConfig(SETTINGS))).not.toContain(TOKEN)
  })
})

describe('transport', () => {
  it('sends the token as a bearer header and never logs it', async () => {
    const fetchMock = mockApi({ 'GET /bookmarks': jsonResponse({ bookmarks: [], total: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(testInstapaperConnection(SETTINGS)).resolves.toMatchObject({ ok: true })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.stringify(console.info.mock.calls)).not.toContain(TOKEN)
  })

  it.each([
    [401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'], [500, 'server_error'], [400, 'request_failed'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', mockApi({ 'GET /bookmarks': jsonResponse({ error: { code: status, message: TOKEN } }, status) }))
    const error = await testInstapaperConnection(SETTINGS).catch(e => e)
    expect(error.message).toBe(code)
  })

  it('reports an unreachable server as network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(testInstapaperConnection(SETTINGS)).rejects.toThrow('network_error')
  })

  it('refuses to run without a token', async () => {
    await expect(testInstapaperConnection({})).rejects.toThrow('not_configured')
  })
})

describe('syncWithInstapaper', () => {
  it('pages through since=1, advancing by bookmarks plus deleted ids', async () => {
    const offsets = []
    const full = Array.from({ length: 300 }, (_, i) => bookmark({ id: i + 1, url: `https://example.com/${i}` }))
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': target => {
        const offset = Number(target.searchParams.get('offset'))
        offsets.push(offset)
        expect(target.searchParams.get('since')).toBe('1')
        // Limit is 500: first page 300 bookmarks + 200 deleted ids = a full page.
        if (offset === 0) return jsonResponse({ bookmarks: full, deleted_ids: Array.from({ length: 200 }, (_, i) => 1000 + i), total: 500 })
        return jsonResponse({ bookmarks: [bookmark({ id: 999, url: 'https://example.com/last' })], deleted_ids: [], total: 501 })
      },
    }))

    const { articles, pulled } = await syncWithInstapaper([], SETTINGS, { newId })
    expect(offsets).toEqual([0, 500])
    expect(articles).toHaveLength(301)
    expect(pulled).toBe(301)
  })

  it('pulls Home and Archive as saved articles, but not folder bookmarks or private content', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': jsonResponse({
        bookmarks: [
          bookmark({ id: 1, url: 'https://a.example/1', archived: false }),
          bookmark({ id: 2, url: 'https://a.example/2', archived: true, pubtime: 1700000000 }),
          bookmark({ id: 3, url: 'https://a.example/3', folder_id: 77 }),
          bookmark({ id: 4, url: null, private_source: 'mail' }),
        ],
        total: 4,
      }),
    }))

    const { articles } = await syncWithInstapaper([], SETTINGS, { newId })
    expect(articles.map(a => a.url).sort()).toEqual(['https://a.example/1', 'https://a.example/2'])

    const archived = articles.find(a => a.url === 'https://a.example/2')
    expect(archived).toMatchObject({ isSaved: true, isArchived: true, feedId: null, isRead: false })
    // pubtime wins over the day it was saved.
    expect(archived.publishedAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('pushes a new saved article without canonicalizing, and ignores unsaved ones', async () => {
    const post = vi.fn(() => jsonResponse(bookmark({ id: 10 })))
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [], total: 0 }),
      'POST /bookmarks': (_t, body) => post(body),
    }))

    const result = await syncWithInstapaper([
      article(),
      article({ id: 'l2', url: 'https://example.com/feed-item', isSaved: false }),
    ], SETTINGS, { newId })

    expect(result).toMatchObject({ pushed: 1, pulled: 0 })
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toEqual({
      url: 'https://example.com/artikel', title: 'Der Titel', description: 'Die Beschreibung',
      archived: false, canonicalize: false,
    })
  })

  it('moves an archived article after saving it if the server did not honour archived', async () => {
    const fetchMock = mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [], total: 0 }),
      'POST /bookmarks': jsonResponse(bookmark({ id: 10, archived: false })),
      'POST /bookmarks/10/move': jsonResponse(bookmark({ id: 10, archived: true })),
    })
    vi.stubGlobal('fetch', fetchMock)

    await syncWithInstapaper([article({ isArchived: true })], SETTINGS, { newId })
    expect(bodyOf(callsTo(fetchMock, 'POST', '/bookmarks/10/move')[0])).toEqual({ section: 'archive' })
  })

  it('never re-saves a bookmark it already knows — folder ones included', async () => {
    const fetchMock = mockApi({
      'GET /bookmarks': jsonResponse({
        bookmarks: [
          bookmark({ id: 1 }),
          bookmark({ id: 2, url: 'https://example.com/im-ordner', folder_id: 5 }),
        ],
        total: 2,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await syncWithInstapaper([
      article(),
      article({ id: 'l2', url: 'https://www.example.com/im-ordner/', title: 'x' }),
    ], SETTINGS, { newId })

    expect(callsTo(fetchMock, 'POST', '/bookmarks')).toHaveLength(0)
    expect(result.pushed).toBe(0)
  })

  it('archives on the server when the local article was archived since the last sync', async () => {
    const fetchMock = mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [bookmark({ id: 1, archived: false })], total: 1 }),
      'POST /bookmarks/1/move': jsonResponse(bookmark({ id: 1, archived: true })),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { articles } = await syncWithInstapaper(
      [article({ isArchived: true, updatedAt: '2026-06-03T00:00:00.000Z' })],
      { ...SETTINGS, lastSync: '2026-06-02T00:00:00.000Z' },
      { newId },
    )
    expect(articles[0].isArchived).toBe(true)
    expect(bodyOf(callsTo(fetchMock, 'POST', '/bookmarks/1/move')[0])).toEqual({ section: 'archive' })
  })

  it('takes the server\'s archive state when only the server changed (restore travels too)', async () => {
    const fetchMock = mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [bookmark({ id: 1, archived: false })], total: 1 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { articles, pulled } = await syncWithInstapaper(
      [article({ isArchived: true, updatedAt: '2026-06-01T00:00:00.000Z' })],
      { ...SETTINGS, lastSync: '2026-06-02T00:00:00.000Z' },
      { newId },
    )
    expect(articles[0].isArchived).toBe(false)
    expect(pulled).toBe(1)
    expect(callsTo(fetchMock, 'POST', '/bookmarks/1/move')).toHaveLength(0)
  })

  it('lets archived win when there is no evidence at all', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [bookmark({ id: 1, archived: true })], total: 1 }),
    }))
    const { articles } = await syncWithInstapaper([article({ isArchived: false })], SETTINGS, { newId })
    expect(articles[0].isArchived).toBe(true)
  })

  it('keeps local data: cachedHtml, summary, isRead, publishedAt and edited text', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [bookmark({ title: 'Remote', description: 'Remote', pubtime: 1700000000 })], total: 1 }),
    }))
    const local = article({ cachedHtml: '<p>x</p>', summary: 'TL;DR', isRead: true, title: 'Mein Titel', description: 'Meine' })
    const { articles } = await syncWithInstapaper([local], SETTINGS, { newId })
    expect(articles[0]).toMatchObject({
      cachedHtml: '<p>x</p>', summary: 'TL;DR', isRead: true, title: 'Mein Titel',
      description: 'Meine', publishedAt: '2026-06-01T10:00:00.000Z',
    })
  })

  it('never deletes a local article because it is missing on the server', async () => {
    vi.stubGlobal('fetch', mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [], total: 0 }),
      'POST /bookmarks': jsonResponse(bookmark({ id: 10 })),
    }))
    const { articles } = await syncWithInstapaper([article()], SETTINGS, { newId })
    expect(articles).toHaveLength(1)
  })
})

describe('pushToInstapaper', () => {
  it('lists the account itself when it is not handed an index', async () => {
    const fetchMock = mockApi({ 'GET /bookmarks': jsonResponse({ bookmarks: [bookmark()], total: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(pushToInstapaper([article()], SETTINGS)).resolves.toEqual({ pushed: 0, skipped: 1 })
  })
})

describe('deleteFromInstapaper', () => {
  it('deletes by the id found through the URL, www and trailing slash folded', async () => {
    const fetchMock = mockApi({
      'GET /bookmarks': jsonResponse({ bookmarks: [bookmark({ id: 42 })], total: 1 }),
      'DELETE /bookmarks/42': jsonResponse(undefined, 200),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteFromInstapaper('https://www.example.com/artikel/', SETTINGS)).resolves.toEqual({ deleted: true })
    expect(callsTo(fetchMock, 'DELETE', '/bookmarks/42')).toHaveLength(1)
  })

  it('reports nothing deleted for an unknown URL', async () => {
    const fetchMock = mockApi({ 'GET /bookmarks': jsonResponse({ bookmarks: [], total: 0 }) })
    vi.stubGlobal('fetch', fetchMock)
    await expect(deleteFromInstapaper('https://example.com/weg', SETTINGS)).resolves.toEqual({ deleted: false })
  })
})

describe('urlKey', () => {
  it('folds fragment, trailing slash, www and host case', () => {
    expect(urlKey('https://WWW.Example.com/a/#x')).toBe(urlKey('https://example.com/a'))
  })
})
