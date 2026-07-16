import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeArticle, extractImage, parseFeedString } from '../src/utils/feedParser.js'

// Mock http so feedParser tests don't make real network calls
vi.mock('../src/utils/http.js', () => ({
  httpGet: vi.fn(),
}))

describe('parseFeedString — declared channel language', () => {
  it('reads the RSS <language> element down to its primary subtag', () => {
    const parsed = parseFeedString(`<?xml version="1.0"?>
      <rss><channel>
        <title>T</title>
        <language>de-DE</language>
        <item><link>https://x.example/a</link><title>A</title></item>
      </channel></rss>`)

    expect(parsed.language).toBe('de')
  })

  it('reads xml:lang from an Atom feed and stays empty when nothing is declared', () => {
    const atom = parseFeedString(`<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB">
        <title>T</title>
        <entry><id>x</id><title>A</title></entry>
      </feed>`)
    expect(atom.language).toBe('en')

    const silent = parseFeedString(`<?xml version="1.0"?>
      <rss><channel><title>T</title></channel></rss>`)
    expect(silent.language).toBe('')
  })
})

describe('normalizeArticle', () => {
  it('maps basic fields', () => {
    const item = {
      link: 'https://example.com/article',
      title: 'Test Title',
      contentSnippet: 'Short excerpt.',
      pubDate: '2025-01-15T10:00:00Z',
    }
    const result = normalizeArticle(item, 'feed-1')
    expect(result.url).toBe('https://example.com/article')
    expect(result.title).toBe('Test Title')
    expect(result.description).toBe('Short excerpt.')
    expect(result.feedId).toBe('feed-1')
    expect(result.isRead).toBe(false)
    expect(result.isSaved).toBe(false)
    expect(result.cachedHtml).toBeNull()
  })

  it('falls back to guid when link is missing', () => {
    const item = { guid: 'https://example.com/guid', title: 'G' }
    expect(normalizeArticle(item, 'f').url).toBe('https://example.com/guid')
  })

  it('uses current date when pubDate is missing', () => {
    const before = Date.now()
    const result = normalizeArticle({ title: 'x' }, 'f')
    const after = Date.now()
    const ts = new Date(result.publishedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('decodes escaped HTML entities in title and description', () => {
    const result = normalizeArticle({
      link: 'https://example.com/article',
      title: 'Rock &#39;n&#39; Roll',
      contentSnippet: 'Tom &amp; Jerry',
    }, 'feed-1')

    expect(result.title).toBe("Rock 'n' Roll")
    expect(result.description).toBe('Tom & Jerry')
  })
})

describe('extractImage', () => {
  it('returns mediaContent url', () => {
    const item = { mediaContent: { $: { url: 'https://img.example.com/1.jpg' } } }
    expect(extractImage(item)).toBe('https://img.example.com/1.jpg')
  })

  it('returns mediaThumbnail url as fallback', () => {
    const item = { mediaThumbnail: { $: { url: 'https://img.example.com/t.jpg' } } }
    expect(extractImage(item)).toBe('https://img.example.com/t.jpg')
  })

  it('finds image in content:encoded', () => {
    const item = { 'content:encoded': '<p><img src="https://example.com/pic.png" /></p>' }
    expect(extractImage(item)).toBe('https://example.com/pic.png')
  })

  it('returns null when no image present', () => {
    expect(extractImage({})).toBeNull()
  })
})
