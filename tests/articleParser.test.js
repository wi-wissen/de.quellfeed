import { describe, expect, it } from 'vitest'
import { buildIframeDoc, FEED_FALLBACK_MARKER_CLASS, fetchArticleContent } from '../src/utils/articleParser.js'

vi.mock('../src/utils/http.js', () => ({
  httpGet: vi.fn(),
}))

vi.mock('../src/utils/domainConfig.js', () => ({
  getDomainConfig: vi.fn(async () => null),
}))

import { httpGet } from '../src/utils/http.js'

describe('buildIframeDoc', () => {
  it('does not inject the feed header image when the config disables it', () => {
    const doc = buildIframeDoc('<p>Body</p>', 'https://example.com/header.jpg', 'system', {
      showFeedImage: false,
    })

    expect(doc).not.toContain('<figure class="article-hero">')
    expect(doc).not.toContain('https://example.com/header.jpg')
  })

  it('injects the feed header image by default when it is missing from the article HTML', () => {
    const doc = buildIframeDoc('<p>Body</p>', 'https://example.com/header.jpg')

    expect(doc).toContain('<figure class="article-hero">')
    expect(doc).toContain('https://example.com/header.jpg')
  })

  it('does not duplicate the feed header image when it is already present in the article HTML', () => {
    const doc = buildIframeDoc('<img src="https://example.com/header.jpg"><p>Body</p>', 'https://example.com/header.jpg')

    expect(doc).not.toContain('<figure class="article-hero">')
  })

  // The cover usually IS the article's lead photo, just under a different CDN URL —
  // an exact URL match misses that and the reader saw the same picture twice.
  it('skips the cover when the article opens with an image of its own, whatever its URL', () => {
    const doc = buildIframeDoc(
      '<p>Kurzer Vorspann.</p><figure><img src="https://cdn.example.com/lead-800x450.jpg"></figure><p>Text</p>',
      'https://example.com/header.jpg',
    )

    expect(doc).not.toContain('<figure class="article-hero">')
  })

  it('still adds the cover when the article only shows an image much further down', () => {
    const doc = buildIframeDoc(
      `<p>${'Text. '.repeat(120)}</p><img src="https://cdn.example.com/deep.jpg">`,
      'https://example.com/header.jpg',
    )

    expect(doc).toContain('<figure class="article-hero">')
  })

  it('lets the domain config force the cover past the heuristic', () => {
    const doc = buildIframeDoc(
      '<img src="https://cdn.example.com/lead.jpg"><p>Text</p>',
      'https://example.com/header.jpg',
      'system',
      { showFeedImage: true },
    )

    expect(doc).toContain('<figure class="article-hero">')
  })
})

describe('fetchArticleContent', () => {
  it('falls back to RSS item data when extracted text is too short', async () => {
    httpGet.mockResolvedValue({
      status: 200,
      data: '<!doctype html><html><body><main><p>Hi</p></main></body></html>',
    })

    const result = await fetchArticleContent('https://example.com/post', '', {
      feedFallback: {
        title: 'Fallback title',
        description: 'Fallback description from the feed.',
        url: 'https://example.com/post',
      },
    })

    expect(result.html).toContain(FEED_FALLBACK_MARKER_CLASS)
    expect(result.html).toContain('Fallback title')
    expect(result.html).toContain('Fallback description from the feed.')
  })

  it('keeps extracted article HTML when enough text was found', async () => {
    httpGet.mockResolvedValue({
      status: 200,
      data: `<!doctype html><html><body><main><p>${'A'.repeat(140)}</p></main></body></html>`,
    })

    const result = await fetchArticleContent('https://example.com/post', '', {
      feedFallback: {
        title: 'Fallback title',
        description: 'Fallback description from the feed.',
        url: 'https://example.com/post',
      },
    })

    expect(result.html).not.toContain(FEED_FALLBACK_MARKER_CLASS)
    expect(result.html).toContain('A'.repeat(140))
  })
})