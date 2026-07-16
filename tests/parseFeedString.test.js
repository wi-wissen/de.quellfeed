import { describe, it, expect, vi } from 'vitest'
import { parseFeedString } from '../src/utils/feedParser.js'

vi.mock('../src/utils/http.js', () => ({ httpGet: vi.fn() }))

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>Artikel Eins</title>
      <link>https://example.com/1</link>
      <guid>https://example.com/1</guid>
      <description>&lt;p&gt;Kurze Beschreibung.&lt;/p&gt;</description>
      <pubDate>Wed, 15 Jan 2025 10:00:00 +0000</pubDate>
      <media:content url="https://example.com/img.jpg" medium="image"/>
    </item>
    <item>
      <title>Artikel Zwei</title>
      <link>https://example.com/2</link>
      <description>Nur Text.</description>
      <pubDate>Thu, 16 Jan 2025 09:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Artikel</title>
    <id>https://example.com/atom/1</id>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <published>2025-01-17T12:00:00Z</published>
    <summary>Zusammenfassung des Artikels.</summary>
  </entry>
</feed>`

const RSS_ESCAPED_ENTITIES_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Tom &amp;#39;s Feed</title>
    <item>
      <title>Rock &amp;#39;n&amp;#39; Roll</title>
      <link>https://example.com/escaped</link>
      <description>&amp;lt;p&amp;gt;A &amp;#39;quoted&amp;#39; snippet.&amp;lt;/p&amp;gt;</description>
      <pubDate>Fri, 17 Jan 2025 10:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

describe('parseFeedString – RSS', () => {
  it('parses feed title', () => {
    const feed = parseFeedString(RSS_SAMPLE)
    expect(feed.title).toBe('Test Feed')
  })

  it('parses all items', () => {
    const feed = parseFeedString(RSS_SAMPLE)
    expect(feed.items).toHaveLength(2)
  })

  it('parses item fields correctly', () => {
    const item = parseFeedString(RSS_SAMPLE).items[0]
    expect(item.title).toBe('Artikel Eins')
    expect(item.link).toBe('https://example.com/1')
    expect(item.contentSnippet).toBe('Kurze Beschreibung.')
    expect(new Date(item.pubDate).getFullYear()).toBe(2025)
  })

  it('extracts media:content image URL', () => {
    const item = parseFeedString(RSS_SAMPLE).items[0]
    expect(item.mediaContent).not.toBeNull()
    expect(item.mediaContent.$.url).toBe('https://example.com/img.jpg')
  })

  it('returns null mediaContent when no image', () => {
    const item = parseFeedString(RSS_SAMPLE).items[1]
    expect(item.mediaContent).toBeNull()
  })
})

describe('parseFeedString – Atom', () => {
  it('parses feed title', () => {
    expect(parseFeedString(ATOM_SAMPLE).title).toBe('Atom Feed')
  })

  it('parses entry link', () => {
    const item = parseFeedString(ATOM_SAMPLE).items[0]
    expect(item.link).toBe('https://example.com/atom/1')
  })

  it('parses entry summary as contentSnippet', () => {
    const item = parseFeedString(ATOM_SAMPLE).items[0]
    expect(item.contentSnippet).toBe('Zusammenfassung des Artikels.')
  })
})

describe('parseFeedString – edge cases', () => {
  it('decodes escaped HTML entities in feed text fields', () => {
    const feed = parseFeedString(RSS_ESCAPED_ENTITIES_SAMPLE)

    expect(feed.title).toBe("Tom 's Feed")
    expect(feed.items[0].title).toBe("Rock 'n' Roll")
    expect(feed.items[0].contentSnippet).toBe("A 'quoted' snippet.")
  })

  it('throws on invalid XML', () => {
    expect(() => parseFeedString('<not valid xml &')).toThrow()
  })

  it('throws on unknown feed format', () => {
    expect(() => parseFeedString('<html><body>not a feed</body></html>')).toThrow('Unknown feed format')
  })
})
