import { describe, it, expect } from 'vitest'
import { classifySharedUrl, extractSharedUrl, looksLikeFeedUrl } from '../src/utils/shareTarget.js'

/**
 * Android's share sheet sends `text/plain`, and almost nobody puts a bare URL in it.
 * Chrome sends "Page title https://example.com/x", other apps append a footer. Treating
 * the payload as a URL would fail on nearly every real share.
 */
describe('extractSharedUrl', () => {
  it('takes a bare URL', () => {
    expect(extractSharedUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('mines the URL out of what Chrome actually sends', () => {
    expect(extractSharedUrl('Massenaussterben: Wer überlebte https://www.spektrum.de/news/123'))
      .toBe('https://www.spektrum.de/news/123')
  })

  it('mines it out of a sentence with a trailing full stop', () => {
    expect(extractSharedUrl('Lies das mal: https://example.com/article.')).toBe('https://example.com/article')
  })

  it('keeps a query string and fragment intact', () => {
    expect(extractSharedUrl('see https://example.com/a?b=1&c=2#top'))
      .toBe('https://example.com/a?b=1&c=2#top')
  })

  it('does not eat a trailing dot that belongs to the path', () => {
    // A real path segment may end in a dot only in pathological cases; a sentence's
    // full stop is far more likely, and losing it is the harmless direction.
    expect(extractSharedUrl('https://example.com/a.b')).toBe('https://example.com/a.b')
  })

  it('takes the first URL when several are shared', () => {
    expect(extractSharedUrl('https://a.example/1 und https://b.example/2'))
      .toBe('https://a.example/1')
  })

  it('accepts http as well as https', () => {
    expect(extractSharedUrl('http://example.com/a')).toBe('http://example.com/a')
  })

  it('returns null for text without a URL', () => {
    expect(extractSharedUrl('nur ein bisschen Text')).toBeNull()
  })

  it('returns null for empty, null and undefined', () => {
    expect(extractSharedUrl('')).toBeNull()
    expect(extractSharedUrl(null)).toBeNull()
    expect(extractSharedUrl(undefined)).toBeNull()
  })

  it('ignores schemes we cannot fetch', () => {
    expect(extractSharedUrl('javascript:alert(1)')).toBeNull()
    expect(extractSharedUrl('mailto:a@example.com')).toBeNull()
    expect(extractSharedUrl('content://media/external/file/42')).toBeNull()
  })
})

/**
 * A shared link is either a site you want to subscribe to or an article you want to keep.
 * Guessing wrong is cheap in one direction (an extra screen) and annoying in the other
 * (an article silently filed as a feed), so the feed side stays deliberately narrow.
 */
describe('looksLikeFeedUrl', () => {
  it('treats a bare domain as a feed — that is the "I want the whole site" signal', () => {
    expect(looksLikeFeedUrl('https://spektrum.de')).toBe(true)
    expect(looksLikeFeedUrl('https://www.spektrum.de/')).toBe(true)
  })

  it('recognises the paths feeds actually live at', () => {
    expect(looksLikeFeedUrl('https://example.com/feed')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/blog/feed/')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/rss')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/atom')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/feeds')).toBe(true)
  })

  it('recognises a feed file by its extension', () => {
    expect(looksLikeFeedUrl('https://example.com/index.xml')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/blog/atom.xml')).toBe(true)
    expect(looksLikeFeedUrl('https://example.com/f.rss')).toBe(true)
  })

  it('recognises the ?feed= query WordPress uses', () => {
    expect(looksLikeFeedUrl('https://example.com/?feed=rss2')).toBe(true)
  })

  // The rule I deliberately did NOT take: "ends in a slash". WordPress permalinks all do,
  // and they are articles — the single most common thing anyone shares.
  it('does NOT call a trailing slash a feed', () => {
    expect(looksLikeFeedUrl('https://example.com/2026/07/mein-artikel/')).toBe(false)
    expect(looksLikeFeedUrl('https://kuketz-blog.de/warum-ich-kein-whatsapp-nutze/')).toBe(false)
  })

  it('leaves ordinary articles alone', () => {
    expect(looksLikeFeedUrl('https://www.spektrum.de/news/massenaussterben/123456')).toBe(false)
    expect(looksLikeFeedUrl('https://example.com/a?utm_source=feedly')).toBe(false)
  })

  it('is not fooled by a word that merely contains "rss" or "feed"', () => {
    expect(looksLikeFeedUrl('https://example.com/feedback')).toBe(false)
    expect(looksLikeFeedUrl('https://example.com/news/feeding-the-world')).toBe(false)
  })

  it('says false for anything that is not a URL', () => {
    expect(looksLikeFeedUrl('not a url')).toBe(false)
    expect(looksLikeFeedUrl('')).toBe(false)
  })
})

describe('classifySharedUrl', () => {
  it('sends a site to the subscribe screen and an article straight to the archive', () => {
    expect(classifySharedUrl('https://spektrum.de')).toBe('feed')
    expect(classifySharedUrl('https://www.spektrum.de/news/123')).toBe('article')
  })
})
