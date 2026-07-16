import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Persistence is not under test here — same reasoning as store.test.js.
vi.mock('../src/utils/storage.js', () => ({
  storageGet: vi.fn(async () => null),
  storageSet: vi.fn(async () => {}),
  storageRemove: vi.fn(async () => {}),
  storageRemoveByPrefix: vi.fn(async () => 0),
}))

// The refresh flow is driven with canned feed items — no network, ever.
vi.mock('../src/utils/feedParser.js', () => ({
  fetchAndParseFeed: vi.fn(async () => ({ title: '', items: [] })),
  discoverFeedUrl: vi.fn(async () => null),
  normalizeArticle: (item, feedId) => ({
    id: item.id || crypto.randomUUID(),
    feedId,
    url: item.link,
    title: item.title || '',
    description: item.contentSnippet || '',
    image: null,
    isRead: false,
    isSaved: false,
    publishedAt: item.pubDate || new Date().toISOString(),
    cachedHtml: null,
  }),
}))

// Only the AI call itself is mocked — isAiConfigured and friends stay real, so the
// store's guards are exercised against the real logic.
vi.mock('../src/utils/ai.js', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    quellFilterArticles: vi.fn(async () => []),
  }
})

const { store } = await import('../src/store/index.js')
const { quellFilterArticles } = await import('../src/utils/ai.js')
const { fetchAndParseFeed } = await import('../src/utils/feedParser.js')

const CONFIGURED_AI = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: 'sk-test-key',
  model: 'deepseek/deepseek-v4-flash',
}

function feedArticle(overrides = {}) {
  return {
    id: 'a-1',
    feedId: 'feed-1',
    url: 'https://example.com/one',
    title: 'Eins',
    description: '',
    image: null,
    isRead: false,
    isSaved: false,
    isQuelled: false,
    publishedAt: '2026-07-01T10:00:00.000Z',
    cachedHtml: null,
    ...overrides,
  }
}

function item(link, title = 'Titel') {
  return { link, title, contentSnippet: 'Snippet', pubDate: '2026-07-10T10:00:00.000Z' }
}

beforeEach(() => {
  store.feeds = []
  store.articles = []
  store.settings.showQuelled = false
  store.settings.ai = { ...CONFIGURED_AI }
  quellFilterArticles.mockClear()
  quellFilterArticles.mockImplementation(async () => [])
  fetchAndParseFeed.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('feedArticles and quelled visibility', () => {
  it('hides quelled articles by default, but keeps them stored', () => {
    store.articles = [feedArticle(), feedArticle({ id: 'a-2', url: 'u2', isQuelled: true })]

    expect(store.feedArticles.map(a => a.id)).toEqual(['a-1'])
    expect(store.articles).toHaveLength(2)
  })

  it('shows quelled articles when showQuelled is on', () => {
    store.articles = [feedArticle(), feedArticle({ id: 'a-2', url: 'u2', isQuelled: true })]
    store.settings.showQuelled = true

    expect(store.feedArticles.map(a => a.id).sort()).toEqual(['a-1', 'a-2'])
  })

  // Articles written before the feature exist without the field — they are visible.
  it('treats a missing isQuelled as not quelled', () => {
    const a = feedArticle()
    delete a.isQuelled
    store.articles = [a]

    expect(store.feedArticles).toHaveLength(1)
  })

  it('persists the showQuelled choice', async () => {
    await store.setShowQuelled(true)
    expect(store.settings.showQuelled).toBe(true)

    const { storageSet } = await import('../src/utils/storage.js')
    expect(storageSet).toHaveBeenCalledWith('quell:settings', expect.objectContaining({ showQuelled: true }))
  })
})

describe('unquellArticle', () => {
  it('clears the flag and stamps updatedAt so the decision syncs', async () => {
    store.articles = [feedArticle({ isQuelled: true, updatedAt: '2026-07-01T10:00:00.000Z' })]

    await store.unquellArticle('a-1')

    expect(store.articles[0].isQuelled).toBe(false)
    expect(store.articles[0].updatedAt).not.toBe('2026-07-01T10:00:00.000Z')
  })

  it('does nothing for an article that is not quelled', async () => {
    store.articles = [feedArticle({ updatedAt: '2026-07-01T10:00:00.000Z' })]

    await store.unquellArticle('a-1')

    expect(store.articles[0].updatedAt).toBe('2026-07-01T10:00:00.000Z')
  })
})

describe('setFeedFilterPrompt', () => {
  it('stores the prompt and stamps updatedAt so the WebDAV merge can carry it', async () => {
    store.feeds = [{ id: 'feed-1', url: 'https://example.com/feed', title: 'Ex', updatedAt: '2026-07-01T10:00:00.000Z' }]

    await store.setFeedFilterPrompt('feed-1', 'keine Themen zur Astronomie')

    expect(store.feeds[0].filterPrompt).toBe('keine Themen zur Astronomie')
    expect(store.feeds[0].updatedAt).not.toBe('2026-07-01T10:00:00.000Z')
  })

  it('does not re-stamp when the prompt is unchanged', async () => {
    store.feeds = [{ id: 'feed-1', url: 'u', title: 'Ex', filterPrompt: 'x', updatedAt: '2026-07-01T10:00:00.000Z' }]

    await store.setFeedFilterPrompt('feed-1', 'x')

    expect(store.feeds[0].updatedAt).toBe('2026-07-01T10:00:00.000Z')
  })
})

describe('getQuelledCount', () => {
  it('counts only this feed\'s quelled articles', () => {
    store.articles = [
      feedArticle({ isQuelled: true }),
      feedArticle({ id: 'a-2', url: 'u2', isQuelled: true, feedId: 'feed-2' }),
      feedArticle({ id: 'a-3', url: 'u3' }),
    ]

    expect(store.getQuelledCount('feed-1')).toBe(1)
  })
})

describe('the quell filter inside the refresh flow', () => {
  function subscribed(overrides = {}) {
    return {
      id: 'feed-1',
      url: 'https://example.com/feed',
      title: 'Example',
      filterPrompt: 'keine Themen zur Astronomie',
      updatedAt: '2026-07-01T10:00:00.000Z',
      ...overrides,
    }
  }

  it('rates ONLY the items that are new to the store, and quells by returned index', async () => {
    const feed = subscribed()
    store.feeds = [feed]
    store.articles = [feedArticle({ url: 'https://example.com/known' })]

    fetchAndParseFeed.mockResolvedValue({
      title: 'Example',
      items: [
        item('https://example.com/known', 'Schon da'),
        item('https://example.com/new-a', 'Astronomie heute'),
        item('https://example.com/new-b', 'Wahlen morgen'),
      ],
    })
    // Index 0 of the FRESH batch — that is new-a, not the known item.
    quellFilterArticles.mockResolvedValue([0])

    await store._refreshFeed(feed)

    expect(quellFilterArticles).toHaveBeenCalledTimes(1)
    const [prompt, batch] = quellFilterArticles.mock.calls[0]
    expect(prompt).toBe('keine Themen zur Astronomie')
    expect(batch.map(a => a.url)).toEqual(['https://example.com/new-a', 'https://example.com/new-b'])

    const byUrl = url => store.articles.find(a => a.url === url)
    expect(byUrl('https://example.com/new-a').isQuelled).toBe(true)
    expect(byUrl('https://example.com/new-b').isQuelled).toBeFalsy()
    expect(byUrl('https://example.com/known').isQuelled).toBe(false)
    // Quelled means stored, not dropped.
    expect(store.articles).toHaveLength(3)
  })

  it('never rates the same items twice — the second refresh sends nothing', async () => {
    const feed = subscribed()
    store.feeds = [feed]

    fetchAndParseFeed.mockResolvedValue({
      title: 'Example',
      items: [item('https://example.com/new-a'), item('https://example.com/new-b')],
    })

    await store._refreshFeed(feed)
    expect(quellFilterArticles).toHaveBeenCalledTimes(1)

    await store._refreshFeed(feed)
    expect(quellFilterArticles).toHaveBeenCalledTimes(1)
  })

  it('skips the AI without a filter prompt', async () => {
    const feed = subscribed({ filterPrompt: '' })
    store.feeds = [feed]
    fetchAndParseFeed.mockResolvedValue({ title: '', items: [item('https://example.com/new-a')] })

    await store._refreshFeed(feed)

    expect(quellFilterArticles).not.toHaveBeenCalled()
    expect(store.articles).toHaveLength(1)
  })

  it('skips the AI when no key is configured', async () => {
    store.settings.ai = { ...CONFIGURED_AI, apiKey: '' }
    const feed = subscribed()
    store.feeds = [feed]
    fetchAndParseFeed.mockResolvedValue({ title: '', items: [item('https://example.com/new-a')] })

    await store._refreshFeed(feed)

    expect(quellFilterArticles).not.toHaveBeenCalled()
    expect(store.articles).toHaveLength(1)
  })

  it('skips the AI while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      const feed = subscribed()
      store.feeds = [feed]
      fetchAndParseFeed.mockResolvedValue({ title: '', items: [item('https://example.com/new-a')] })

      await store._refreshFeed(feed)

      expect(quellFilterArticles).not.toHaveBeenCalled()
      expect(store.articles).toHaveLength(1)
    } finally {
      delete navigator.onLine
    }
  })

  it('fails open: a broken AI quells nothing and the refresh still finishes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const feed = subscribed()
    store.feeds = [feed]
    fetchAndParseFeed.mockResolvedValue({
      title: '',
      items: [item('https://example.com/new-a'), item('https://example.com/new-b')],
    })
    quellFilterArticles.mockRejectedValue(new Error('server_error'))

    await expect(store._refreshFeed(feed)).resolves.toBeUndefined()

    expect(store.articles).toHaveLength(2)
    expect(store.articles.every(a => !a.isQuelled)).toBe(true)
    expect(warn).toHaveBeenCalled()
    // The key must never end up in the warning either.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test-key')
  })

  it('ignores out-of-range indices from the AI', async () => {
    const feed = subscribed()
    store.feeds = [feed]
    fetchAndParseFeed.mockResolvedValue({ title: '', items: [item('https://example.com/new-a')] })
    quellFilterArticles.mockResolvedValue([0, 7])

    await store._refreshFeed(feed)

    expect(store.articles).toHaveLength(1)
    expect(store.articles[0].isQuelled).toBe(true)
  })
})
