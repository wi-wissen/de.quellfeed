import { describe, it, expect } from 'vitest'
import { exportBookmarks, parseBookmarks } from '../src/utils/bookmarks.js'

const SAMPLE_LINKS = [
  {
    id: '1',
    feedId: null,
    source: 'spiegel.de',
    url: 'https://www.spiegel.de/artikel-a-1',
    title: 'Ein Artikel',
    description: 'Eine Beschreibung',
    publishedAt: '2024-03-01T12:00:00.000Z',
  },
  {
    id: '2',
    feedId: null,
    source: 'example.com',
    url: 'https://example.com/search?a=1&b=2',
    title: 'Tom & Jerry',
    description: 'Katz & Maus <b>Klassiker</b>',
    publishedAt: '2025-11-20T08:30:00.000Z',
  },
]

describe('exportBookmarks', () => {
  it('produces a Netscape bookmark file with all links', () => {
    const html = exportBookmarks(SAMPLE_LINKS)
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
    expect(html).toContain('<TITLE>Bookmarks</TITLE>')
    expect(html).toContain('<H1>Bookmarks</H1>')
    expect(html).toContain('<DL><p>')
    expect(html).toContain('</DL><p>')
    expect(html).toContain('Ein Artikel')
    expect(html).toContain('www.spiegel.de/artikel-a-1')
  })

  it('puts the entries in a "Quell" folder', () => {
    const html = exportBookmarks(SAMPLE_LINKS)
    expect(html).toMatch(/<DT><H3[^>]*>Quell<\/H3>/)
  })

  it('names the folder per shelf — the archive exports as "Quell Archive"', () => {
    const html = exportBookmarks(SAMPLE_LINKS, { folder: 'Quell Archive' })
    expect(html).toMatch(/<DT><H3[^>]*>Quell Archive<\/H3>/)
    expect(parseBookmarks(html)).toHaveLength(SAMPLE_LINKS.length)
  })

  it('writes ADD_DATE as unix seconds, not milliseconds', () => {
    const html = exportBookmarks(SAMPLE_LINKS)
    const seconds = Date.parse('2024-03-01T12:00:00.000Z') / 1000
    expect(seconds).toBe(1709294400)
    expect(html).toContain(`ADD_DATE="${seconds}"`)
    expect(html).not.toContain('ADD_DATE="1709294400000"')
  })

  it('escapes HTML entities in titles, descriptions and urls', () => {
    const html = exportBookmarks(SAMPLE_LINKS)
    expect(html).toContain('Tom &amp; Jerry')
    expect(html).toContain('?a=1&amp;b=2')
    expect(html).toContain('Katz &amp; Maus &lt;b&gt;Klassiker&lt;/b&gt;')
    expect(html).not.toContain('<b>Klassiker</b>')
  })

  it('writes a description as a <DD> line only when there is one', () => {
    const html = exportBookmarks([{ url: 'https://example.com/', title: 'Kein Text', description: '', publishedAt: null }])
    expect(html).toContain('<DT><A HREF="https://example.com/"')
    expect(html).not.toContain('<DD>')
  })

  it('omits ADD_DATE when publishedAt is missing', () => {
    const html = exportBookmarks([{ url: 'https://example.com/', title: 'Ohne Datum', publishedAt: null }])
    expect(html).not.toContain('ADD_DATE="null"')
    expect(parseBookmarks(html)[0].publishedAt).toBeNull()
  })
})

describe('parseBookmarks', () => {
  it('round-trips through export/import', () => {
    const parsed = parseBookmarks(exportBookmarks(SAMPLE_LINKS))
    expect(parsed).toHaveLength(2)
    expect(parsed.map(p => p.url)).toEqual(SAMPLE_LINKS.map(l => l.url))
    expect(parsed.map(p => p.title)).toEqual(SAMPLE_LINKS.map(l => l.title))
    expect(parsed.map(p => p.description)).toEqual(SAMPLE_LINKS.map(l => l.description))
  })

  it('round-trips ADD_DATE back to the original ISO date', () => {
    const parsed = parseBookmarks(exportBookmarks(SAMPLE_LINKS))
    expect(parsed[0].publishedAt).toBe('2024-03-01T12:00:00.000Z')
    expect(parsed[1].publishedAt).toBe('2025-11-20T08:30:00.000Z')
  })

  it('round-trips entities in titles and urls', () => {
    const parsed = parseBookmarks(exportBookmarks(SAMPLE_LINKS))
    expect(parsed[1].title).toBe('Tom & Jerry')
    expect(parsed[1].url).toBe('https://example.com/search?a=1&b=2')
    expect(parsed[1].description).toBe('Katz & Maus <b>Klassiker</b>')
  })

  it('parses sloppy real-world markup: unclosed DT/DD, lowercase tags, unquoted attributes', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <dt><a href="https://a.example/one" add_date=1709294400>Erster</a>
        <dd>Beschreibung eins
        <DT><A HREF=https://b.example/two ADD_DATE="1700000000">Zweiter</A>
        <DT><A HREF="https://c.example/three">Dritter</A>
      </DL><p>`
    const parsed = parseBookmarks(html)
    expect(parsed).toHaveLength(3)
    expect(parsed[0]).toEqual({
      url: 'https://a.example/one',
      title: 'Erster',
      description: 'Beschreibung eins',
      publishedAt: '2024-03-01T12:00:00.000Z',
    })
    expect(parsed[1].url).toBe('https://b.example/two')
    expect(parsed[1].description).toBe('')
    expect(parsed[2].publishedAt).toBeNull()
  })

  it('flattens folders', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><A HREF="https://root.example/">Wurzel</A>
        <DT><H3>Nachrichten</H3>
        <DL><p>
          <DT><A HREF="https://news.example/">Nachricht</A>
          <DT><H3>Tief</H3>
          <DL><p>
            <DT><A HREF="https://deep.example/">Tief verschachtelt</A>
          </DL><p>
        </DL><p>
      </DL><p>`
    const parsed = parseBookmarks(html)
    expect(parsed.map(p => p.url)).toEqual([
      'https://root.example/',
      'https://news.example/',
      'https://deep.example/',
    ])
  })

  it('skips entries without href and non-http(s) urls', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><A ADD_DATE="1709294400">Kein HREF</A>
        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
        <DT><A HREF="place:sort=8&maxResults=10">Zuletzt besucht</A>
        <DT><A HREF="data:text/html,hi">Daten</A>
        <DT><A HREF="ftp://files.example/x">FTP</A>
        <DT><A HREF="https://ok.example/">Gut</A>
      </DL><p>`
    const parsed = parseBookmarks(html)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].url).toBe('https://ok.example/')
  })

  it('yields publishedAt null for a missing or garbage ADD_DATE', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <DL><p>
        <DT><A HREF="https://a.example/">Ohne</A>
        <DT><A HREF="https://b.example/" ADD_DATE="">Leer</A>
        <DT><A HREF="https://c.example/" ADD_DATE="gestern">Mist</A>
      </DL><p>`
    const parsed = parseBookmarks(html)
    expect(parsed).toHaveLength(3)
    expect(parsed.every(p => p.publishedAt === null)).toBe(true)
  })

  it('falls back to the url when a link has no text', () => {
    const parsed = parseBookmarks('<DL><p><DT><A HREF="https://a.example/"></A></DL><p>')
    expect(parsed[0].title).toBe('https://a.example/')
  })

  it('returns [] for an empty bookmark file', () => {
    const empty = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
      <TITLE>Bookmarks</TITLE>
      <H1>Bookmarks</H1>
      <DL><p>
      </DL><p>`
    expect(parseBookmarks(empty)).toEqual([])
    expect(parseBookmarks('')).toEqual([])
    expect(parseBookmarks(exportBookmarks([]))).toEqual([])
  })
})
