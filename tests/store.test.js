import { describe, it, expect, vi, beforeEach } from 'vitest'

// The store persists on every mutation. Nothing here is about persistence, and a real
// Preferences round-trip would only make the tests slow and order-dependent.
vi.mock('../src/utils/storage.js', () => ({
  storageGet: vi.fn(async () => null),
  storageSet: vi.fn(async () => {}),
  storageRemove: vi.fn(async () => {}),
  storageRemoveByPrefix: vi.fn(async () => 0),
}))

// Saving an article now starts its offline download in the background — without this
// mock every toggleSave in here would hit the real network.
vi.mock('../src/utils/articleParser.js', () => ({
  fetchArticleContent: vi.fn(async () => ({ html: '<p>heruntergeladen</p>', config: null, language: 'en' })),
}))

const { fetchArticleContent } = await import('../src/utils/articleParser.js')
const { store } = await import('../src/store/index.js')

/** toggleSave fires the prefetch without awaiting it — the tests have to. */
const flushPrefetch = () => new Promise(resolve => setTimeout(resolve, 0))

/** An article that came out of a subscribed feed. */
function feedArticle(overrides = {}) {
  return {
    id: 'a-feed',
    feedId: 'feed-1',
    url: 'https://example.com/from-the-feed',
    title: 'Aus dem Feed',
    description: '',
    image: null,
    isRead: false,
    isSaved: false,
    publishedAt: '2026-07-01T10:00:00.000Z',
    cachedHtml: null,
    ...overrides,
  }
}

/** A link: added by hand, shared in, imported, or pulled from KaraKeep. No feed behind it. */
function linkArticle(overrides = {}) {
  return {
    id: 'a-link',
    feedId: null,
    source: 'example.com',
    url: 'https://example.com/a-single-link',
    title: 'Einzelner Link',
    description: '',
    image: null,
    isRead: false,
    isSaved: true,
    publishedAt: '2026-07-02T10:00:00.000Z',
    cachedHtml: null,
    ...overrides,
  }
}

beforeEach(() => {
  store.feeds = []
  store.articles = []
  fetchArticleContent.mockClear()
})

describe('store.feedArticles', () => {
  /**
   * The bug this pins down: `feedArticles` returned the whole article list, so a saved
   * link showed up under Saved *and* in the Feed tab — in a user's case, a Feed tab for a
   * user who had not subscribed to a single feed.
   */
  it('never shows a link (feedId null) in the feed', () => {
    store.articles = [linkArticle()]

    expect(store.feedArticles).toEqual([])
    expect(store.savedArticles).toHaveLength(1)
  })

  it('shows an article that came from a feed', () => {
    store.articles = [feedArticle()]

    expect(store.feedArticles).toHaveLength(1)
    expect(store.feedArticles[0].id).toBe('a-feed')
  })

  // Saving is a bookmark, not a move: the article is still in the feed it came from.
  it('keeps a saved feed article in the feed, and puts it in saved as well', () => {
    store.articles = [feedArticle({ isSaved: true })]

    expect(store.feedArticles).toHaveLength(1)
    expect(store.savedArticles).toHaveLength(1)
  })

  it('separates the two lists when both kinds are present', () => {
    store.articles = [feedArticle(), linkArticle()]

    expect(store.feedArticles.map(a => a.id)).toEqual(['a-feed'])
    expect(store.savedArticles.map(a => a.id)).toEqual(['a-link'])
  })

  // A link with a falsy-but-not-null feedId ('' from a bad sync payload, say) is still a
  // link. Boolean(feedId), not `feedId !== null`.
  it('treats an empty feedId as no feed', () => {
    store.articles = [linkArticle({ feedId: '' })]

    expect(store.feedArticles).toEqual([])
  })
})

describe('store.savedArticles', () => {
  it('holds every saved article, whatever its origin', () => {
    store.articles = [feedArticle({ isSaved: true }), linkArticle(), feedArticle({ id: 'a-2', url: 'u2' })]

    expect(store.savedArticles.map(a => a.id).sort()).toEqual(['a-feed', 'a-link'])
  })
})

describe('saving from the feed', () => {
  it('does not move the article out of the feed', async () => {
    store.articles = [feedArticle()]

    await store.toggleSave('a-feed')

    expect(store.articles[0].isSaved).toBe(true)
    expect(store.feedArticles).toHaveLength(1)
    expect(store.savedArticles).toHaveLength(1)
  })

  // Saving promises offline readability — the download must not wait for the first open.
  it('downloads the article right at the save', async () => {
    store.articles = [feedArticle()]

    await store.toggleSave('a-feed')
    await flushPrefetch()

    expect(fetchArticleContent).toHaveBeenCalledWith(
      'https://example.com/from-the-feed',
      expect.anything(),
      expect.anything(),
    )
    expect(store.articles[0].cachedHtml).toBe('<p>heruntergeladen</p>')
    // The page's declared language rides along — it places the translate button.
    expect(store.articles[0].language).toBe('en')
  })

  it('takes the HTML the caller already holds instead of fetching again', async () => {
    // The reading view has the article on screen; downloading it a second time
    // would be pure cost.
    store.articles = [feedArticle()]

    await store.toggleSave('a-feed', { html: '<p>schon geladen</p>' })
    await flushPrefetch()

    expect(store.articles[0].cachedHtml).toBe('<p>schon geladen</p>')
    expect(fetchArticleContent).not.toHaveBeenCalled()
  })

  it('swallows a failed download — the first open caches like before', async () => {
    fetchArticleContent.mockRejectedValueOnce(new Error('HTTP 404'))
    store.articles = [feedArticle()]

    await store.toggleSave('a-feed')
    await flushPrefetch()

    expect(store.articles[0].isSaved).toBe(true)
    expect(store.articles[0].cachedHtml).toBeNull()
  })

  it('discards a download that finishes after the user unsaved again', async () => {
    let release
    fetchArticleContent.mockImplementationOnce(
      () => new Promise(resolve => { release = resolve }),
    )
    store.articles = [feedArticle()]

    await store.toggleSave('a-feed') // save — download starts
    await store.toggleSave('a-feed') // unsave, before it finishes
    release({ html: '<p>zu spät</p>', config: null, language: 'en' })
    await flushPrefetch()

    // A late result must not resurrect the cache of an unsaved article.
    expect(store.articles[0].isSaved).toBe(false)
    expect(store.articles[0].cachedHtml).toBeNull()
  })
})

describe('unsubscribing a feed', () => {
  it('keeps saved and archived articles as links and buries only the rest', async () => {
    store.feeds = [{ id: 'feed-1', url: 'https://example.com/feed.xml', title: 'Example' }]
    store.tombstones = { feeds: {}, articles: {} }
    store.articles = [
      feedArticle({ id: 'a-plain', url: 'https://example.com/plain' }),
      feedArticle({ id: 'a-saved', url: 'https://example.com/saved', isSaved: true }),
      feedArticle({ id: 'a-arch', url: 'https://example.com/arch', isSaved: true, isArchived: true, cachedHtml: '<p>offline</p>' }),
    ]

    await store.removeFeed('feed-1')

    // The bookmarked two survive, detached into links; the plain one is gone.
    expect(store.articles.map(a => a.id).sort()).toEqual(['a-arch', 'a-saved'])
    expect(store.articles.every(a => a.feedId === null)).toBe(true)
    expect(store.articles.find(a => a.id === 'a-arch').cachedHtml).toBe('<p>offline</p>')

    // Graves: the feed, and ONLY the plain article — a tombstone for a survivor would
    // delete it from every other device on the next sync.
    expect(Object.keys(store.tombstones.feeds)).toEqual(['https://example.com/feed.xml'])
    expect(Object.keys(store.tombstones.articles)).toEqual(['https://example.com/plain'])
  })
})

describe('the archive', () => {
  it('archiving files the article away: out of saved, into the archive', async () => {
    store.articles = [linkArticle()]

    await store.archiveArticle('a-link')

    expect(store.articles[0].isArchived).toBe(true)
    expect(store.savedArticles).toEqual([])
    expect(store.archivedArticles.map(a => a.id)).toEqual(['a-link'])
  })

  it('archiving a feed article saves it too — archived means "keep forever"', async () => {
    store.articles = [feedArticle({ isSaved: false })]

    await store.archiveArticle('a-feed')

    expect(store.articles[0].isArchived).toBe(true)
    expect(store.articles[0].isSaved).toBe(true)
    // Saving is a bookmark, not a move: it also stays in the feed it came from.
    expect(store.feedArticles).toHaveLength(1)
  })

  it('archiving keeps the cachedHtml — the archive is the offline shelf', async () => {
    store.articles = [linkArticle({ cachedHtml: '<p>offline</p>' })]

    await store.archiveArticle('a-link')

    expect(store.articles[0].cachedHtml).toBe('<p>offline</p>')
  })

  it('stamps updatedAt — without it the sync would lose the state change', async () => {
    store.articles = [linkArticle({ updatedAt: '2026-07-01T00:00:00.000Z' })]

    await store.archiveArticle('a-link')
    const archivedStamp = store.articles[0].updatedAt
    expect(archivedStamp).not.toBe('2026-07-01T00:00:00.000Z')

    await store.unarchiveArticle('a-link')
    expect(store.articles[0].updatedAt).not.toBe('2026-07-01T00:00:00.000Z')
  })

  it('restore puts the article back on the saved list, cache intact', async () => {
    store.articles = [linkArticle({ isArchived: true, cachedHtml: '<p>offline</p>' })]

    await store.unarchiveArticle('a-link')

    expect(store.articles[0].isArchived).toBe(false)
    expect(store.articles[0].isSaved).toBe(true)
    expect(store.articles[0].cachedHtml).toBe('<p>offline</p>')
    expect(store.savedArticles).toHaveLength(1)
    expect(store.archivedArticles).toEqual([])
  })

  it('unsaving a feed article takes it out of the archive too', async () => {
    // An archived article is by definition a saved one — unsave must not leave an
    // archived-but-unsaved zombie behind.
    store.articles = [feedArticle({ isSaved: true, isArchived: true, cachedHtml: '<p>x</p>' })]

    await store.toggleSave('a-feed')

    expect(store.articles[0].isSaved).toBe(false)
    expect(store.articles[0].isArchived).toBe(false)
    expect(store.articles[0].cachedHtml).toBeNull()
    expect(store.archivedArticles).toEqual([])
  })

  it('deleting an archived link still works and writes its tombstone', async () => {
    store.articles = [linkArticle({ isArchived: true })]
    store.tombstones = { feeds: {}, articles: {} }

    await store.removeArticle('a-link')

    expect(store.articles).toEqual([])
    expect(Object.keys(store.tombstones.articles)).toEqual(['https://example.com/a-single-link'])
  })

  it('saved and archive are disjoint lists', () => {
    store.articles = [
      linkArticle({ id: 'l-1', url: 'https://example.com/1' }),
      linkArticle({ id: 'l-2', url: 'https://example.com/2', isArchived: true }),
    ]

    expect(store.savedArticles.map(a => a.id)).toEqual(['l-1'])
    expect(store.archivedArticles.map(a => a.id)).toEqual(['l-2'])
  })
})
