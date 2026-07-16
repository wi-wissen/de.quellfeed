import { describe, it, expect, vi, beforeEach } from 'vitest'
import { discoverFeeds, discoverFeedUrl } from '../src/utils/feedParser.js'
import { httpGet } from '../src/utils/http.js'

vi.mock('../src/utils/http.js', () => ({
  httpGet: vi.fn(),
}))

const FEED_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Example Feed</title>
  <item><title>A</title><link>https://example.com/a</link></item>
</channel></rss>`

/** Answers each URL from a map; anything not in the map is a 404. */
function serve(routes) {
  httpGet.mockImplementation(async url => {
    if (url in routes) return { status: 200, data: routes[url] }
    return { status: 404, data: 'Not Found' }
  })
}

beforeEach(() => {
  httpGet.mockReset()
})

describe('discoverFeeds', () => {
  it('accepts a URL that is already a feed and reads its title', async () => {
    serve({ 'https://example.com/feed': FEED_XML })

    const feeds = await discoverFeeds('https://example.com/feed')

    expect(feeds).toEqual([{ url: 'https://example.com/feed', title: 'Example Feed' }])
  })

  it('assumes https:// when the scheme is missing', async () => {
    serve({ 'https://example.com/feed': FEED_XML })

    expect(await discoverFeedUrl('example.com/feed')).toBe('https://example.com/feed')
  })

  it('finds <link rel="alternate"> in HTML', async () => {
    serve({
      'https://example.com': `<html><head>
        <link rel="alternate" type="application/rss+xml" title="Main" href="/rss.xml">
      </head><body></body></html>`,
    })

    const feeds = await discoverFeeds('https://example.com')

    expect(feeds).toEqual([{ url: 'https://example.com/rss.xml', title: 'Main' }])
  })

  // The regression that made spektrum.de undiscoverable: the old regex required
  // quotes around the attribute values, and spektrum.de writes none.
  it('finds feeds in HTML with unquoted attributes', async () => {
    serve({
      'https://www.spektrum.de/': `<html><head>
        <link href=https://www.spektrum.de/alias/rss/sciviews/1481729 rel=alternate title="SciViews" type=application/rss+xml>
        <link href=https://www.spektrum.de/alias/rss/spektrum-de-rss-feed/996406 rel=alternate title="Spektrum.de RSS-Feed" type=application/rss+xml>
      </head><body></body></html>`,
    })

    const feeds = await discoverFeeds('https://www.spektrum.de/')

    expect(feeds).toHaveLength(2)
    expect(feeds[1]).toEqual({
      url: 'https://www.spektrum.de/alias/rss/spektrum-de-rss-feed/996406',
      title: 'Spektrum.de RSS-Feed',
    })
  })

  it('returns every advertised feed so the caller can let the user pick', async () => {
    serve({
      'https://example.com': `<html><head>
        <link rel="alternate" type="application/rss+xml" title="News" href="/news.xml">
        <link rel="alternate" type="application/atom+xml" title="Blog" href="/blog.atom">
      </head></html>`,
    })

    const feeds = await discoverFeeds('https://example.com')

    expect(feeds.map(f => f.title)).toEqual(['News', 'Blog'])
  })

  it('deduplicates feeds advertised twice', async () => {
    serve({
      'https://example.com': `<html><head>
        <link rel="alternate" type="application/rss+xml" href="/rss.xml">
        <link rel="alternate" type="application/rss+xml" href="https://example.com/rss.xml">
      </head></html>`,
    })

    expect(await discoverFeeds('https://example.com')).toHaveLength(1)
  })

  it('ignores <link> tags that are not feeds', async () => {
    serve({
      'https://example.com': `<html><head>
        <link rel="stylesheet" href="/style.css">
        <link rel="icon" href="/favicon.ico">
      </head></html>`,
    })

    expect(await discoverFeeds('https://example.com')).toEqual([])
  })

  it('falls back to probing common feed paths', async () => {
    serve({
      'https://example.com': '<html><head></head><body>no feed link here</body></html>',
      'https://example.com/feed': FEED_XML,
    })

    const feeds = await discoverFeeds('https://example.com')

    expect(feeds).toEqual([{ url: 'https://example.com/feed', title: 'Example Feed' }])
  })

  it('returns an empty list when nothing is discoverable', async () => {
    httpGet.mockResolvedValue({ status: 404, data: 'Not Found' })

    expect(await discoverFeeds('https://example.com')).toEqual([])
    expect(await discoverFeedUrl('https://example.com')).toBeNull()
  })

  it('survives the initial fetch throwing and still probes', async () => {
    httpGet.mockImplementation(async url => {
      if (url === 'https://example.com') throw new Error('network down')
      if (url === 'https://example.com/rss') return { status: 200, data: FEED_XML }
      return { status: 404, data: '' }
    })

    expect(await discoverFeedUrl('https://example.com')).toBe('https://example.com/rss')
  })
})
