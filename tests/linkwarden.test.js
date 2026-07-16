import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LINKWARDEN_SETTINGS,
  deleteFromLinkwarden,
  getLinkwardenTransport,
  isLinkwardenConfigured,
  pullFromLinkwarden,
  pushToLinkwarden,
  resolveLinkwardenConfig,
  syncWithLinkwarden,
  testLinkwardenConnection,
  urlKey,
} from '../src/utils/linkwarden.js'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) },
  CapacitorHttp: { request: vi.fn() },
}))

const API_KEY = 'lw_super_secret_token_1234567890'

const SETTINGS = {
  baseUrl: 'https://links.example.com',
  apiKey: API_KEY,
  collectionName: 'Quell Feed',
  enabled: true,
  lastSync: null,
}

const COLLECTION = { id: 3, ownerId: 1, name: 'Quell Feed' }

let idCounter = 0
const newId = () => `id-${++idCounter}`

/** A Linkwarden link as the API returns it. Note: `name`, not `title`. */
function link(overrides = {}) {
  return {
    id: 42,
    url: 'https://example.com/artikel',
    name: 'Der Titel',
    description: 'Die Beschreibung',
    // An archive PATH — not a picture of the article, and never read into our `image`.
    image: 'archives/preview/3/42.jpeg',
    icon: null,
    iconWeight: null,
    color: null,
    collection: { id: 3, ownerId: 1, name: 'Quell Feed' },
    tags: [{ id: 7, name: 'rss' }],
    pinnedBy: [],
    createdAt: '2026-06-01T10:00:00.000Z',
    // Prisma stamps this on every update — the archive LWW compares against it.
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
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
    publishedAt: '2026-06-01T10:00:00.000Z',
    cachedHtml: null,
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

/** Routes keyed by `METHOD /path`; each may be a value or a fn(url, body). */
function mockApi(routes) {
  CapacitorHttp.request.mockImplementation(async ({ method, url, data }) => {
    const parsed = new URL(url)
    const key = `${method} ${parsed.pathname}`

    const route = routes[key]
    if (!route) throw new Error(`unexpected request: ${key}`)

    const body = data ? JSON.parse(data) : undefined
    const result = typeof route === 'function' ? await route(parsed, body) : route

    return {
      status: result?.status ?? 200,
      data: result?.body === undefined ? '' : JSON.stringify(result.body),
      headers: {},
    }
  })
  return CapacitorHttp.request
}

const ok = body => ({ status: 200, body })
const created = body => ({ status: 201, body })

/** The two routes every call needs before it can touch a link. */
function withCollections(routes, collections = [COLLECTION]) {
  return {
    'GET /api/v1/collections': ok({ response: collections }),
    'POST /api/v1/collections': created({ response: COLLECTION }),
    ...routes,
  }
}

function callsTo(method, pathname) {
  return CapacitorHttp.request.mock.calls.filter(([options]) =>
    options.method === method && new URL(options.url).pathname === pathname)
}

function bodyOf(call) {
  return JSON.parse(call[0].data)
}

beforeEach(() => {
  idCounter = 0
  vi.clearAllMocks()
  Capacitor.isNativePlatform.mockReturnValue(true)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('config', () => {
  it('defaults to a disabled account with its own collection', () => {
    expect(DEFAULT_LINKWARDEN_SETTINGS).toEqual({
      baseUrl: '',
      apiKey: '',
      collectionName: 'Quell Feed',
      enabled: false,
      lastSync: null,
    })
  })

  it('knows when a request could be made', () => {
    expect(isLinkwardenConfigured(SETTINGS)).toBe(true)
    expect(isLinkwardenConfigured({ ...SETTINGS, apiKey: '' })).toBe(false)
    expect(isLinkwardenConfigured({ ...SETTINGS, baseUrl: '' })).toBe(false)
    expect(isLinkwardenConfigured(null)).toBe(false)
  })

  it('strips a trailing slash and a pasted /api/v1 from the address', () => {
    expect(resolveLinkwardenConfig({ baseUrl: 'https://l.example.com/' }).baseUrl)
      .toBe('https://l.example.com')
    expect(resolveLinkwardenConfig({ baseUrl: 'https://l.example.com/api/v1' }).baseUrl)
      .toBe('https://l.example.com')
  })

  it('redacts the token when the config is stringified', () => {
    const json = JSON.stringify(resolveLinkwardenConfig(SETTINGS))

    expect(json).not.toContain(API_KEY)
    expect(json).toContain('[redacted]')
    expect(resolveLinkwardenConfig(SETTINGS).apiKey).toBe(API_KEY)
  })
})

describe('error codes', () => {
  it('throws not_configured without a token — and fires no request at all', async () => {
    const blind = { ...SETTINGS, apiKey: '' }

    await expect(testLinkwardenConnection(blind)).rejects.toThrow('not_configured')
    await expect(pullFromLinkwarden(blind)).rejects.toThrow('not_configured')
    await expect(pushToLinkwarden([article()], blind)).rejects.toThrow('not_configured')
    await expect(syncWithLinkwarden([article()], blind)).rejects.toThrow('not_configured')
    await expect(deleteFromLinkwarden('https://example.com/a', blind)).rejects.toThrow('not_configured')

    expect(CapacitorHttp.request).not.toHaveBeenCalled()
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
    mockApi({ 'GET /api/v1/collections': { status, body: { response: 'nope' } } })

    await expect(testLinkwardenConnection(SETTINGS)).rejects.toThrow(code)
  })

  it('carries the status on the error', async () => {
    mockApi({ 'GET /api/v1/collections': { status: 429, body: {} } })

    await expect(testLinkwardenConnection(SETTINGS))
      .rejects.toMatchObject({ message: 'rate_limited', status: 429 })
  })

  it('maps an unreachable server to network_error', async () => {
    CapacitorHttp.request.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(testLinkwardenConnection(SETTINGS)).rejects.toThrow('network_error')
  })

  it('still recognizes the status when a platform rejects instead of resolving', async () => {
    CapacitorHttp.request.mockRejectedValue(Object.assign(new Error('HTTP 401'), { status: 401 }))

    await expect(testLinkwardenConnection(SETTINGS)).rejects.toThrow('unauthorized')
  })
})

describe('testLinkwardenConnection', () => {
  it('sends the bearer token and counts the collections', async () => {
    mockApi({ 'GET /api/v1/collections': ok({ response: [COLLECTION] }) })

    await expect(testLinkwardenConnection(SETTINGS))
      .resolves.toEqual({ ok: true, status: 200, collections: 1 })

    const [options] = CapacitorHttp.request.mock.calls[0]
    expect(options.url).toBe('https://links.example.com/api/v1/collections')
    expect(options.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })
})

describe('collections', () => {
  it('resolves the collection id once and sends { id }, never { name }', async () => {
    // `collection: { name }` is NOT find-or-create — setCollection.ts unconditionally
    // CREATEs anything that is not literally "Unorganized". Three pushes with { name }
    // would leave three collections called "Quell Feed" behind.
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([
      article({ url: 'https://example.com/a' }),
      article({ url: 'https://example.com/b' }),
      article({ url: 'https://example.com/c' }),
    ], SETTINGS)

    expect(callsTo('GET', '/api/v1/collections')).toHaveLength(1)
    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(0)

    for (const call of callsTo('POST', '/api/v1/links')) {
      expect(bodyOf(call).collection).toEqual({ id: 3 })
      expect(bodyOf(call).collection).not.toHaveProperty('name')
    }
  })

  it('creates the collection exactly once when it does not exist yet', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }, []))

    await pushToLinkwarden([
      article({ url: 'https://example.com/a' }),
      article({ url: 'https://example.com/b' }),
    ], SETTINGS)

    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(1)
    expect(bodyOf(callsTo('POST', '/api/v1/collections')[0])).toEqual({ name: 'Quell Feed' })
  })

  it('matches an existing collection case-insensitively instead of creating a twin', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }, [{ id: 9, ownerId: 1, name: 'quell feed' }]))

    await pushToLinkwarden([article()], SETTINGS)

    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(0)
    expect(bodyOf(callsTo('POST', '/api/v1/links')[0]).collection).toEqual({ id: 9 })
  })

  it('sends no collection at all when none is configured — the server uses Unorganized', async () => {
    mockApi({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    })

    await pushToLinkwarden([article()], { ...SETTINGS, collectionName: '' })

    expect(callsTo('GET', '/api/v1/collections')).toHaveLength(0)
    expect(bodyOf(callsTo('POST', '/api/v1/links')[0])).not.toHaveProperty('collection')
  })
})

describe('push', () => {
  it('creates a link the server does not have yet', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    const result = await pushToLinkwarden([article()], SETTINGS)

    expect(result).toEqual({ pushed: 1, skipped: 0 })
    expect(bodyOf(callsTo('POST', '/api/v1/links')[0])).toEqual({
      url: 'https://example.com/artikel',
      // `name`, not `title` — Linkwarden has no `title` field.
      name: 'Der Titel',
      description: 'Die Beschreibung',
      type: 'url',
      tags: [],
      collection: { id: 3 },
    })
  })

  // Same fence as the delete: an unscoped per-article lookup would find the user's own
  // bookmark of the same URL in a collection of theirs, and then PUT our title over it.
  it('looks the article up only inside our collection', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article()], SETTINGS)

    const [search] = callsTo('GET', '/api/v1/search')
    expect(new URL(search[0].url).searchParams.get('collectionId')).toBe('3')
  })

  // The single most important test in this file.
  it('creates NO duplicate when the url is already on the server', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }))

    const result = await pushToLinkwarden([article()], SETTINGS)

    expect(callsTo('POST', '/api/v1/links')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  // /search matches a SUBSTRING of the url, so it happily answers with a different article
  // whose URL merely contains ours. Believing it would mean never pushing that article.
  it('does not mistake a substring hit for the same article', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({
        data: {
          // Our url is https://example.com/artikel — this one merely contains it.
          links: [link({ id: 99, url: 'https://example.com/artikel/teil-2' })],
          nextCursor: null,
        },
      }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    const result = await pushToLinkwarden([article()], SETTINGS)

    expect(callsTo('POST', '/api/v1/links')).toHaveLength(1)
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('recognizes the same article under a trailing slash, a fragment and www.', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    const result = await pushToLinkwarden(
      [article({ url: 'https://www.example.com/artikel/#lesen' })],
      SETTINGS,
    )

    expect(callsTo('POST', '/api/v1/links')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  it('treats a 409 "Link already exists" as a skip, not as an error', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': { status: 409, body: { response: 'Link already exists' } },
    }))

    await expect(pushToLinkwarden([article()], SETTINGS))
      .resolves.toEqual({ pushed: 0, skipped: 1 })
  })

  it('ignores articles that are not saved and urls it cannot use', async () => {
    mockApi(withCollections({}))

    const result = await pushToLinkwarden([
      article({ isSaved: false }),
      article({ url: 'javascript:alert(1)' }),
      article({ url: '' }),
    ], SETTINGS)

    expect(CapacitorHttp.request).not.toHaveBeenCalled()
    expect(result).toEqual({ pushed: 0, skipped: 0 })
  })

  it('never uploads cachedHtml or the paid-for summary', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden(
      [article({ cachedHtml: '<p>Megabytes</p>', summary: 'Die teure KI-Zusammenfassung.' })],
      SETTINGS,
    )

    const body = bodyOf(callsTo('POST', '/api/v1/links')[0])
    expect(body).not.toHaveProperty('cachedHtml')
    expect(body).not.toHaveProperty('summary')
    expect(JSON.stringify(body)).not.toContain('Megabytes')
    expect(JSON.stringify(body)).not.toContain('teure')
  })

  it('sends no date — there is nowhere to put one', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article({ publishedAt: '2026-03-15T06:00:00.000Z' })], SETTINGS)

    const body = bodyOf(callsTo('POST', '/api/v1/links')[0])
    expect(body).not.toHaveProperty('createdAt')
    expect(body).not.toHaveProperty('publishedAt')
    expect(body).not.toHaveProperty('importDate')
  })

  it('never sends `image` — Linkwarden\'s image is an archive format, not a picture', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article({ image: 'https://example.com/bild.jpg' })], SETTINGS)

    expect(bodyOf(callsTo('POST', '/api/v1/links')[0])).not.toHaveProperty('image')
  })
})

describe('the PUT trap — a partial update WIPES what it omits', () => {
  const routes = extra => withCollections({
    'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
    'PUT /api/v1/links/42': ok({ response: link() }),
    'POST /api/v1/links': created({ response: link() }),
    ...extra,
  })

  it('sends a fully hydrated body when the title changed', async () => {
    mockApi(routes())

    const result = await pushToLinkwarden([article({ title: 'Neuer Titel' })], SETTINGS)

    expect(result).toEqual({ pushed: 1, skipped: 0 })

    const body = bodyOf(callsTo('PUT', '/api/v1/links/42')[0])
    expect(body).toMatchObject({
      id: 42,
      url: 'https://example.com/artikel',
      name: 'Neuer Titel',
      // updateLinkById does `description: data.description || ""` — omitting this would
      // silently empty the description the user can see. THIS is the regression.
      description: 'Die Beschreibung',
      collection: { id: 3, ownerId: 1 },
      tags: [{ name: 'rss' }],
    })
  })

  it('never omits description, name, url, collection or tags from a PUT', async () => {
    mockApi(routes())

    await pushToLinkwarden([article({ description: 'Neue Beschreibung' })], SETTINGS)

    const body = bodyOf(callsTo('PUT', '/api/v1/links/42')[0])

    // Every one of these is wiped (or 400s) if it is missing.
    for (const field of ['id', 'url', 'name', 'description', 'collection', 'tags']) {
      expect(body[field]).toBeDefined()
    }
    expect(body.description).toBe('Neue Beschreibung')
    expect(body.name).toBe('Der Titel')
    expect(body.collection.ownerId).toBe(1)
    expect(body.tags).toEqual([{ name: 'rss' }])
  })

  it('carries the existing tags back, because an omitted `tags` removes them all', async () => {
    // removePreviousTags is hardcoded true in the route: tags: { set: [], connectOrCreate }.
    mockApi(withCollections({
      'GET /api/v1/search': ok({
        data: { links: [link({ tags: [{ id: 1, name: 'rss' }, { id: 2, name: 'lesen' }] })], nextCursor: null },
      }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }))

    await pushToLinkwarden([article({ title: 'Neuer Titel' })], SETTINGS)

    expect(bodyOf(callsTo('PUT', '/api/v1/links/42')[0]).tags)
      .toEqual([{ name: 'rss' }, { name: 'lesen' }])
  })

  // Measured against a live server: omitting `pinnedBy` PRESERVES an existing pin and the
  // rest of the update still applies. `pinnedBy: []` is what would unpin the link. (A
  // populated `pinnedBy` does not short-circuit the route, contrary to the folklore — but
  // Quell has no pin to send, so it sends none.)
  it('omits pinnedBy — sending it empty would unpin what the user pinned', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link({ pinnedBy: [{ id: 1 }] })], nextCursor: null } }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }))

    await pushToLinkwarden([article({ title: 'Neuer Titel' })], SETTINGS)

    expect(bodyOf(callsTo('PUT', '/api/v1/links/42')[0])).not.toHaveProperty('pinnedBy')
  })

  it('does not PUT at all when nothing drifted', async () => {
    mockApi(routes())

    const result = await pushToLinkwarden([article()], SETTINGS)

    expect(callsTo('PUT', '/api/v1/links/42')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })
})

describe('pull', () => {
  it('maps a link into the store article shape', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
    }))

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })

    expect(articles).toEqual([{
      id: 'id-1',
      feedId: null,
      source: 'example.com',
      url: 'https://example.com/artikel',
      // `name` is the title.
      title: 'Der Titel',
      description: 'Die Beschreibung',
      // NOT link.image — that is "archives/preview/3/42.jpeg", an archive path.
      image: null,
      isRead: false,
      isSaved: true,
      // The main collection is the saved shelf; the archive one is read separately.
      isArchived: false,
      // The IMPORT date. Linkwarden cannot carry a publish date.
      publishedAt: '2026-06-01T10:00:00.000Z',
      cachedHtml: null,
      updatedAt: '2026-06-01T10:00:00.000Z',
    }])
  })

  it('scopes the pull to our collection — not the user\'s whole library', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
    }))

    await pullFromLinkwarden(SETTINGS, { newId })

    const [options] = callsTo('GET', '/api/v1/search')[0]
    expect(new URL(options.url).searchParams.get('collectionId')).toBe('3')
  })

  it('uses /search, not the deprecated /links', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
    }))

    await pullFromLinkwarden(SETTINGS, { newId })

    expect(callsTo('GET', '/api/v1/links')).toHaveLength(0)
    expect(callsTo('GET', '/api/v1/search')).toHaveLength(1)
  })

  it('survives the `data: []` a Meilisearch instance answers with when nothing matched', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: [], success: true, message: 'Success' }),
    }))

    await expect(pullFromLinkwarden(SETTINGS, { newId })).resolves.toEqual({ articles: [] })
  })
})

describe('pagination', () => {
  it('collects every page of the cursor loop', async () => {
    const pages = {
      '': { links: [link({ id: 1, url: 'https://example.com/1' })], nextCursor: 1 },
      1: { links: [link({ id: 2, url: 'https://example.com/2' })], nextCursor: 2 },
      2: { links: [link({ id: 3, url: 'https://example.com/3' })], nextCursor: null },
    }

    mockApi(withCollections({
      'GET /api/v1/search': url => ok({ data: pages[url.searchParams.get('cursor') || ''] }),
    }))

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })

    expect(callsTo('GET', '/api/v1/search')).toHaveLength(3)
    expect(articles.map(a => a.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ])
  })

  it('terminates on a broken server that keeps handing back the same cursor', async () => {
    // Without the guard this is an infinite loop that pins the CPU and never resolves.
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: 7 } }),
    }))

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })

    // Page one, then page two comes back with a cursor we have already followed → stop.
    expect(callsTo('GET', '/api/v1/search')).toHaveLength(2)
    expect(articles).toHaveLength(1) // the same link twice, deduped by url on the way in
  })

  it('stops at the page cap even when every cursor is new', async () => {
    let n = 0
    mockApi(withCollections({
      'GET /api/v1/search': () => ok({ data: { links: [link({ id: ++n, url: `https://example.com/${n}` })], nextCursor: n } }),
    }))

    await pullFromLinkwarden(SETTINGS, { newId })

    expect(callsTo('GET', '/api/v1/search').length).toBeLessThanOrEqual(200)
  })

  it('stops on an empty page even if the server keeps offering a cursor', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: 5 } }),
    }))

    await pullFromLinkwarden(SETTINGS, { newId })

    expect(callsTo('GET', '/api/v1/search')).toHaveLength(1)
  })
})

describe('syncWithLinkwarden', () => {
  const routes = (links = []) => withCollections({
    'GET /api/v1/search': ok({ data: { links, nextCursor: null } }),
    'POST /api/v1/links': created({ response: link() }),
    'PUT /api/v1/links/42': ok({ response: link() }),
  })

  it('pulls what is new, pushes what is missing, and returns the full list', async () => {
    mockApi(routes([link({ id: 9, url: 'https://example.com/nur-remote' })]))

    const local = [article({ id: 'local-1', url: 'https://example.com/nur-lokal' })]
    const result = await syncWithLinkwarden(local, SETTINGS, { newId })

    expect(result.pulled).toBe(1)
    expect(result.pushed).toBe(1)
    expect(result.articles.map(a => a.url).sort()).toEqual([
      'https://example.com/nur-lokal',
      'https://example.com/nur-remote',
    ])
    expect(bodyOf(callsTo('POST', '/api/v1/links')[0]).url).toBe('https://example.com/nur-lokal')
  })

  it('creates no duplicate for an article that is on both sides', async () => {
    mockApi(routes([link()]))

    const result = await syncWithLinkwarden([article()], SETTINGS, { newId })

    expect(callsTo('POST', '/api/v1/links')).toHaveLength(0)
    expect(result.articles).toHaveLength(1)
    expect(result.pushed).toBe(0)
  })

  it('resolves the collection exactly once for the whole round-trip', async () => {
    mockApi(routes([]))

    await syncWithLinkwarden([
      article({ url: 'https://example.com/a' }),
      article({ url: 'https://example.com/b' }),
    ], SETTINGS, { newId })

    expect(callsTo('GET', '/api/v1/collections')).toHaveLength(1)
  })

  it('spends no per-article search — the listing already told it everything', async () => {
    mockApi(routes([link()]))

    await syncWithLinkwarden([article()], SETTINGS, { newId })

    // One listing for the pull, and nothing more.
    expect(callsTo('GET', '/api/v1/search')).toHaveLength(1)
  })

  it('never overwrites the local cachedHtml or summary on a pull', async () => {
    mockApi(routes([link({ name: 'Serverseitig anders', description: 'Auch anders' })]))

    const local = article({
      cachedHtml: '<p>Der gecachte Artikel</p>',
      summary: 'Die teuer bezahlte Zusammenfassung.',
    })

    const { articles } = await syncWithLinkwarden([local], SETTINGS, { newId })

    expect(articles[0].cachedHtml).toBe('<p>Der gecachte Artikel</p>')
    expect(articles[0].summary).toBe('Die teuer bezahlte Zusammenfassung.')
  })

  it('never overwrites the local read state — Linkwarden has no read flag to overwrite it with', async () => {
    mockApi(routes([link()]))

    const { articles } = await syncWithLinkwarden([article({ isRead: true })], SETTINGS, { newId })

    expect(articles[0].isRead).toBe(true)
  })

  it('does NOT downgrade a known publishedAt to the import date', async () => {
    // The whole point: Linkwarden's createdAt is the day it was imported, not the day the
    // article was published. A date we already have is always the better one.
    mockApi(routes([link({ createdAt: '2026-06-01T10:00:00.000Z' })]))

    const local = article({ publishedAt: '2026-03-15T06:00:00.000Z' })
    const { articles } = await syncWithLinkwarden([local], SETTINGS, { newId })

    expect(articles[0].publishedAt).toBe('2026-03-15T06:00:00.000Z')
  })

  it('takes the import date only for an article it has never seen', async () => {
    mockApi(routes([link({ id: 9, url: 'https://example.com/neu', createdAt: '2026-06-01T10:00:00.000Z' })]))

    const { articles } = await syncWithLinkwarden([], SETTINGS, { newId })

    expect(articles[0].publishedAt).toBe('2026-06-01T10:00:00.000Z')
  })

  it('keeps the local id — nobody else\'s id ever enters this device', async () => {
    mockApi(routes([link()]))

    const { articles } = await syncWithLinkwarden([article({ id: 'local-1' })], SETTINGS, { newId })

    expect(articles[0].id).toBe('local-1')
  })

  it('does not turn a feed article into a second, saved copy of itself', async () => {
    mockApi(routes([link()]))

    const feedArticle = article({ id: 'local-1', feedId: 'feed-1', isSaved: false })
    const { articles } = await syncWithLinkwarden([feedArticle], SETTINGS, { newId })

    expect(articles).toHaveLength(1)
    expect(articles[0].feedId).toBe('feed-1')
    expect(articles[0].isSaved).toBe(true)
  })

  it('does not delete a local article that is no longer on the server', async () => {
    mockApi(routes([]))

    const { articles } = await syncWithLinkwarden([article()], SETTINGS, { newId })

    expect(articles).toHaveLength(1)
  })
})

describe('the archive — a second collection "<name> Archive"', () => {
  const ARCHIVE = { id: 4, ownerId: 1, name: 'Quell Feed Archive' }

  /** A /search route that answers per collectionId, like the live server does. */
  const searchByShelf = shelves => url =>
    ok({ data: { links: shelves[url.searchParams.get('collectionId')] || [], nextCursor: null } })

  it('creates the archive collection lazily and posts the archived article into it', async () => {
    const request = mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({}),
      'POST /api/v1/collections': created({ response: ARCHIVE }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article({ isArchived: true })], SETTINGS)

    expect(bodyOf(callsTo('POST', '/api/v1/collections')[0])).toEqual({ name: 'Quell Feed Archive' })
    expect(bodyOf(callsTo('POST', '/api/v1/links')[0]).collection).toEqual({ id: 4 })
    expect(request).toBeDefined()
  })

  it('creates NO archive collection while nothing is archived', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({}),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article()], SETTINGS)

    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(0)
  })

  it('archives by MOVING the link — a fully hydrated PUT with the archive collection id', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({ 3: [link()], 4: [] }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }, [COLLECTION, ARCHIVE]))

    const result = await pushToLinkwarden([article({ isArchived: true })], SETTINGS)

    const body = bodyOf(callsTo('PUT', '/api/v1/links/42')[0])
    expect(body.collection).toEqual({ id: 4, ownerId: 1 })
    // Hydrated like every PUT — a move must not wipe name, description or tags.
    expect(body.name).toBe('Der Titel')
    expect(body.description).toBe('Die Beschreibung')
    expect(body.tags).toEqual([{ name: 'rss' }])
    expect(result).toEqual({ pushed: 1, skipped: 0 })
  })

  it('restores by moving it back into the main collection', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({ 3: [], 4: [link({ collection: { id: 4, ownerId: 1, name: 'Quell Feed Archive' } })] }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }, [COLLECTION, ARCHIVE]))

    await pushToLinkwarden([article({ isArchived: false })], SETTINGS)

    expect(bodyOf(callsTo('PUT', '/api/v1/links/42')[0]).collection).toEqual({ id: 3, ownerId: 1 })
  })

  it('leaves a correctly shelved link alone', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({ 3: [], 4: [link({ collection: { id: 4, ownerId: 1, name: 'Quell Feed Archive' } })] }),
    }, [COLLECTION, ARCHIVE]))

    const result = await pushToLinkwarden([article({ isArchived: true })], SETTINGS)

    expect(callsTo('PUT', '/api/v1/links/42')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })

  it('pulls archive links as isArchived: true, main links as false', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({
        3: [link()],
        4: [link({ id: 43, url: 'https://example.com/abgelegt', collection: { id: 4, ownerId: 1 } })],
      }),
    }, [COLLECTION, ARCHIVE]))

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })

    const byUrl = Object.fromEntries(articles.map(a => [a.url, a]))
    expect(byUrl['https://example.com/artikel'].isArchived).toBe(false)
    expect(byUrl['https://example.com/abgelegt'].isArchived).toBe(true)
    expect(byUrl['https://example.com/abgelegt'].isSaved).toBe(true)
  })

  it('syncs the archive state down — a link archived on the server archives the article', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({ 3: [], 4: [link({ collection: { id: 4, ownerId: 1 } })] }),
    }, [COLLECTION, ARCHIVE]))

    const { articles, pulled } = await syncWithLinkwarden([article({ isArchived: false })], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(true)
    expect(pulled).toBe(1)
  })

  it('restore travels through the sync: a NEWER local un-archive moves the link back', async () => {
    // The OR trap: without last-write-wins the sync right after a restore would read the
    // archive shelf, set isArchived back to true, and never move the link.
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({
        3: [],
        4: [link({ collection: { id: 4, ownerId: 1 }, updatedAt: '2026-06-02T10:00:00.000Z' })],
      }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }, [COLLECTION, ARCHIVE]))

    const local = article({ isArchived: false, updatedAt: '2026-06-03T10:00:00.000Z' })
    const { articles } = await syncWithLinkwarden([local], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(false)
    expect(bodyOf(callsTo('PUT', '/api/v1/links/42')[0]).collection).toEqual({ id: 3, ownerId: 1 })
  })

  it('a NEWER archive on the server beats an older local state', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({
        3: [],
        4: [link({ collection: { id: 4, ownerId: 1 }, updatedAt: '2026-06-05T10:00:00.000Z' })],
      }),
    }, [COLLECTION, ARCHIVE]))

    const local = article({ isArchived: false, updatedAt: '2026-06-03T10:00:00.000Z' })
    const { articles } = await syncWithLinkwarden([local], SETTINGS, { newId })

    expect(articles[0].isArchived).toBe(true)
    expect(callsTo('PUT', '/api/v1/links/42')).toHaveLength(0)
  })

  it('deletes a link that lives on the archive shelf', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': searchByShelf({ 3: [], 4: [link({ collection: { id: 4, ownerId: 1 } })] }),
      'DELETE /api/v1/links/42': ok({ response: {} }),
    }, [COLLECTION, ARCHIVE]))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: true })
    expect(callsTo('DELETE', '/api/v1/links/42')).toHaveLength(1)
  })

  // The acceptance criterion, archive edition: syncing twice with an archived article
  // leaves exactly TWO collections and ONE link — idempotent from the second run on.
  it('two syncs with an archived article: two collections, one link, nothing on the second run', async () => {
    let collections = [{ ...COLLECTION }]
    const shelves = { 3: [], 4: [] }

    mockApi({
      'GET /api/v1/collections': () => ok({ response: collections }),
      'POST /api/v1/collections': (_url, body) => {
        const row = { id: 4, ownerId: 1, name: body.name }
        collections = [...collections, row]
        return created({ response: row })
      },
      'GET /api/v1/search': url =>
        ok({ data: { links: [...(shelves[url.searchParams.get('collectionId')] || [])], nextCursor: null } }),
      'POST /api/v1/links': (_url, body) => {
        const row = link({ id: 100, url: body.url, name: body.name, description: body.description, collection: { id: body.collection.id, ownerId: 1 } })
        shelves[body.collection.id].push(row)
        return created({ response: row })
      },
    })

    const first = await syncWithLinkwarden([article({ isArchived: true })], SETTINGS, { newId })
    const second = await syncWithLinkwarden(first.articles, SETTINGS, { newId })

    expect(collections).toHaveLength(2)
    expect(shelves[4]).toHaveLength(1)
    expect(shelves[3]).toHaveLength(0)
    expect(second.pushed).toBe(0)
    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(1)
    expect(callsTo('POST', '/api/v1/links')).toHaveLength(1)
  })

  it('does not round-trip the archive in "Unorganized" mode — and does not move anything', async () => {
    mockApi({
      'GET /api/v1/search': ok({ data: { links: [link({ collection: { id: 1, ownerId: 1, name: 'Unorganized' } })], nextCursor: null } }),
    })

    const result = await pushToLinkwarden(
      [article({ isArchived: true })],
      { ...SETTINGS, collectionName: '' },
    )

    // No collections request, no PUT — the link stays exactly where it is.
    expect(callsTo('GET', '/api/v1/collections')).toHaveLength(0)
    expect(callsTo('PUT', '/api/v1/links/42')).toHaveLength(0)
    expect(result).toEqual({ pushed: 0, skipped: 1 })
  })
})

describe('deleteFromLinkwarden', () => {
  it('deletes the link behind a url', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
      'DELETE /api/v1/links/42': ok({ response: {} }),
    }))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: true })
    expect(callsTo('DELETE', '/api/v1/links/42')).toHaveLength(1)
  })

  it('is a no-op when there is nothing to delete', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
    }))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: false })
  })

  it('does not delete a link that merely contains the url as a substring', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({
        data: { links: [link({ id: 99, url: 'https://example.com/artikel/teil-2' })], nextCursor: null },
      }),
    }))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: false })
    expect(callsTo('DELETE', '/api/v1/links/99')).toHaveLength(0)
  })

  // The bug this replaced: the lookup was unscoped, so unsaving an article in Quell
  // deleted the user's OWN bookmark of the same URL out of a collection Quell never wrote
  // to. Reproduced against a live server before the fix, and it really was gone.
  it('searches only inside our collection — never the user\'s whole library', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
    }))

    await deleteFromLinkwarden('https://example.com/artikel', SETTINGS)

    const [search] = callsTo('GET', '/api/v1/search')
    expect(new URL(search[0].url).searchParams.get('collectionId')).toBe('3')
  })

  it('leaves a link alone that lives in a collection of the user\'s own', async () => {
    // The server, asked only about OUR collection, has nothing — the bookmark sits in
    // "User Private Stuff". A scoped search is what makes that invisible to us.
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'DELETE /api/v1/links/42': ok({ response: {} }),
    }))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: false })
    expect(callsTo('DELETE', '/api/v1/links/42')).toHaveLength(0)
  })

  it('does not CREATE the collection just to discover it has nothing to delete', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
    }, []))

    await expect(deleteFromLinkwarden('https://example.com/artikel', SETTINGS))
      .resolves.toEqual({ deleted: false })
    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(0)
    // Nothing of ours can exist without the collection, so it does not even search.
    expect(callsTo('GET', '/api/v1/search')).toHaveLength(0)
  })

  it('falls back to the whole library when no collection is configured', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
      'DELETE /api/v1/links/42': ok({ response: {} }),
    }))

    await expect(deleteFromLinkwarden('https://example.com/artikel', { ...SETTINGS, collectionName: '' }))
      .resolves.toEqual({ deleted: true })

    const [search] = callsTo('GET', '/api/v1/search')
    expect(new URL(search[0].url).searchParams.has('collectionId')).toBe(false)
  })
})

// Everything in here was measured against a real Linkwarden server (v2, self-hosted) and
// is written down so a refactor cannot quietly drift away from what the API actually does.
describe('shapes and behaviours observed on a live server', () => {
  // Two POSTs with `collection: { name: "Quell Feed" }` really do produce two collections
  // both called "Quell Feed" — setCollection.ts special-cases only "Unorganized" and
  // CREATEs anything else, unconditionally. This is the whole reason for resolveCollectionId.
  it('never sends collection:{name} on a link — that is a create, not a find-or-create', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden([article()], SETTINGS)

    const body = bodyOf(callsTo('POST', '/api/v1/links')[0])
    expect(body.collection).toEqual({ id: 3 })
    expect(body.collection).not.toHaveProperty('name')
  })

  // THE acceptance criterion: syncing twice must not double anything.
  it('two syncs produce exactly ONE collection and ONE link', async () => {
    const links = []
    let collections = []

    mockApi({
      'GET /api/v1/collections': () => ok({ response: collections }),
      'POST /api/v1/collections': (_url, body) => {
        // The live server does NOT dedupe by name: it appends every time it is asked.
        const row = { id: 3, ownerId: 1, name: body.name }
        collections = [...collections, row]
        return created({ response: row })
      },
      'GET /api/v1/search': () => ok({ data: { links: [...links], nextCursor: null } }),
      'POST /api/v1/links': (_url, body) => {
        const row = link({ id: 100 + links.length, url: body.url, name: body.name, description: body.description })
        links.push(row)
        return created({ response: row })
      },
    })

    const first = await syncWithLinkwarden([article()], SETTINGS, { newId })
    const second = await syncWithLinkwarden(first.articles, SETTINGS, { newId })

    expect(collections).toHaveLength(1)
    expect(links).toHaveLength(1)
    expect(second.pushed).toBe(0)
    expect(second.articles).toHaveLength(1)
    expect(callsTo('POST', '/api/v1/collections')).toHaveLength(1)
    expect(callsTo('POST', '/api/v1/links')).toHaveLength(1)
  })

  // The envelope really is `{ data: { links, nextCursor }, success, message }` — note that
  // /search answers under `data`, while /collections answers under `response`.
  it('reads links out of data.links and collections out of response', async () => {
    mockApi({
      'GET /api/v1/collections': ok({ response: [COLLECTION] }),
      'GET /api/v1/search': ok({
        data: { links: [link()], nextCursor: null },
        success: true,
        message: 'Success',
      }),
    })

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })

    expect(articles).toHaveLength(1)
    expect(articles[0].url).toBe('https://example.com/artikel')
  })

  // A PUT that omits `name` or `description` is accepted with a 200 and WIPES the field;
  // one that omits `tags`, `collection` or `id` is a 400. Both halves say the same thing:
  // hydrate everything.
  it('sends every field the PUT schema needs, none of them empty by accident', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [link()], nextCursor: null } }),
      'PUT /api/v1/links/42': ok({ response: link() }),
    }))

    await pushToLinkwarden([article({ title: 'Neuer Titel' })], SETTINGS)

    const body = bodyOf(callsTo('PUT', '/api/v1/links/42')[0])
    expect(body.id).toBe(42)
    expect(body.url).toBe('https://example.com/artikel')
    expect(body.name).toBe('Neuer Titel')
    expect(body.description).toBe('Die Beschreibung')
    // z.object({ id, ownerId }) — neither optional, an omission is a 400.
    expect(body.collection).toEqual({ id: 3, ownerId: 1 })
    expect(Array.isArray(body.tags)).toBe(true)
  })

  // The server caps both at 2048 and answers a longer one with
  // 400 "Too big: expected string to have <=2048 characters".
  it('truncates name and description to the 2048 the schema allows', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pushToLinkwarden(
      [article({ title: 'x'.repeat(3000), description: 'y'.repeat(3000) })],
      SETTINGS,
    )

    const body = bodyOf(callsTo('POST', '/api/v1/links')[0])
    expect(body.name).toHaveLength(2048)
    expect(body.description).toHaveLength(2048)
  })

  // With preventDuplicateLinks on, a duplicate POST is 409 { response: "Link already
  // exists" }. That is the outcome we wanted anyway, not an error to show the user.
  it('treats the 409 body the server really sends as a skip', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': { status: 409, body: { response: 'Link already exists' } },
    }))

    await expect(pushToLinkwarden([article()], SETTINGS))
      .resolves.toEqual({ pushed: 0, skipped: 1 })
  })

  // createdAt on a pulled link is the day it was IMPORTED — the API has no field for a
  // publish date at all, so this is the best that exists, and it must never overwrite ours.
  it('takes the import date as publishedAt, and never sends a date back', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({
        data: { links: [link({ createdAt: '2026-07-12T09:37:28.558Z' })], nextCursor: null },
      }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    const { articles } = await pullFromLinkwarden(SETTINGS, { newId })
    expect(articles[0].publishedAt).toBe('2026-07-12T09:37:28.558Z')

    await pushToLinkwarden([article({ url: 'https://example.com/neu' })], SETTINGS)
    const body = bodyOf(callsTo('POST', '/api/v1/links')[0])
    expect(body).not.toHaveProperty('createdAt')
    expect(body).not.toHaveProperty('publishedAt')
    expect(body).not.toHaveProperty('importDate')
  })
})

describe('the browser dev build goes through the Vite proxy', () => {
  // Linkwarden sends no Access-Control-Allow-Origin, so a direct browser call dies on
  // CORS. The /__dav middleware is only *named* after WebDAV — it passes the method, the
  // body and the Authorization header straight through.
  it('routes through /__dav instead of CapacitorHttp, carrying auth and the body', async () => {
    Capacitor.isNativePlatform.mockReturnValue(false)
    expect(getLinkwardenTransport()).toBe('proxy')

    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ response: [COLLECTION] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await testLinkwardenConnection(SETTINGS)

    expect(CapacitorHttp.request).not.toHaveBeenCalled()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/__dav?url=')
    expect(decodeURIComponent(url)).toContain('https://links.example.com/api/v1/collections')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('reports network_error when the proxy itself is unreachable', async () => {
    Capacitor.isNativePlatform.mockReturnValue(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(testLinkwardenConnection(SETTINGS)).rejects.toThrow('network_error')
  })

  it('uses CapacitorHttp in the native build', async () => {
    mockApi({ 'GET /api/v1/collections': ok({ response: [] }) })

    expect(getLinkwardenTransport()).toBe('native')
    await testLinkwardenConnection(SETTINGS)

    expect(CapacitorHttp.request).toHaveBeenCalledTimes(1)
  })
})

describe('the access token never leaves the device in a log or an error', () => {
  const leaks = value => JSON.stringify(value ?? '').includes(API_KEY)

  it('keeps it out of every error message, even from a server that echoes the request', async () => {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      mockApi({
        'GET /api/v1/collections': {
          status,
          body: { response: `Invalid token: ${API_KEY}`, headers: { Authorization: `Bearer ${API_KEY}` } },
        },
      })

      const error = await testLinkwardenConnection(SETTINGS).catch(e => e)

      expect(error).toBeInstanceOf(Error)
      expect(leaks(error.message)).toBe(false)
      expect(leaks(error.stack)).toBe(false)
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(API_KEY)
    }
  })

  it('keeps it out of a network error, even when the transport echoes the request', async () => {
    CapacitorHttp.request.mockRejectedValue(new Error(`connect failed, Bearer ${API_KEY}`))

    const error = await testLinkwardenConnection(SETTINGS).catch(e => e)

    expect(error.message).toBe('network_error')
    expect(leaks(error.message)).toBe(false)
  })

  it('keeps it out of every log line', async () => {
    mockApi(withCollections({
      'GET /api/v1/search': ok({ data: { links: [], nextCursor: null } }),
      'POST /api/v1/links': created({ response: link() }),
    }))

    await pullFromLinkwarden(SETTINGS, { newId })
    await pushToLinkwarden([article()], SETTINGS)

    CapacitorHttp.request.mockRejectedValue(new Error(`boom ${API_KEY}`))
    await testLinkwardenConnection(SETTINGS).catch(() => {})

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
