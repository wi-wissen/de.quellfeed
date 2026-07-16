import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchLinkMetadata, normalizeUrl } from '../src/utils/linkParser.js'
import { httpGet } from '../src/utils/http.js'

vi.mock('../src/utils/http.js', () => ({
  httpGet: vi.fn(),
}))

function respondWith(html) {
  httpGet.mockResolvedValue({ status: 200, data: html })
}

beforeEach(() => {
  httpGet.mockReset()
})

describe('normalizeUrl', () => {
  it('adds https:// when the scheme is missing', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a')
  })

  it('keeps an existing scheme', () => {
    expect(normalizeUrl('http://example.com/a')).toBe('http://example.com/a')
  })

  it('rejects empty input', () => {
    expect(() => normalizeUrl('   ')).toThrow('empty_url')
  })

  it('rejects garbage input', () => {
    expect(() => normalizeUrl('http://')).toThrow()
  })
})

describe('fetchLinkMetadata', () => {
  it('prefers Open Graph tags', async () => {
    respondWith(`
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG description.">
        <meta property="og:image" content="/img/hero.jpg">
        <meta property="og:site_name" content="Example News">
        <meta property="article:published_time" content="2025-03-04T09:30:00Z">
      </head><body></body></html>
    `)

    const meta = await fetchLinkMetadata('https://example.com/story')

    expect(meta.title).toBe('OG Title')
    expect(meta.description).toBe('OG description.')
    expect(meta.image).toBe('https://example.com/img/hero.jpg')
    expect(meta.source).toBe('Example News')
    expect(meta.publishedAt).toBe('2025-03-04T09:30:00.000Z')
  })

  it('falls back to <title>, meta description and hostname', async () => {
    respondWith(`
      <html><head>
        <title>Plain Title</title>
        <meta name="description" content="Plain description.">
      </head><body></body></html>
    `)

    const meta = await fetchLinkMetadata('https://www.example.com/story')

    expect(meta.title).toBe('Plain Title')
    expect(meta.description).toBe('Plain description.')
    expect(meta.image).toBeNull()
    expect(meta.source).toBe('example.com')
    expect(meta.publishedAt).toBeNull()
  })

  it('resolves the canonical URL', async () => {
    respondWith(`
      <html><head>
        <link rel="canonical" href="https://example.com/story">
      </head><body></body></html>
    `)

    const meta = await fetchLinkMetadata('https://example.com/story?utm_source=newsletter')

    expect(meta.url).toBe('https://example.com/story')
  })

  it('keeps the requested URL when there is no canonical', async () => {
    respondWith('<html><head><title>T</title></head><body></body></html>')

    const meta = await fetchLinkMetadata('example.com/story')

    expect(meta.url).toBe('https://example.com/story')
  })

  it('throws on a non-200 response', async () => {
    httpGet.mockResolvedValue({ status: 404, data: '' })

    await expect(fetchLinkMetadata('https://example.com/gone')).rejects.toThrow('HTTP 404')
  })

  it('caps the description length', async () => {
    respondWith(`<html><head><meta property="og:description" content="${'x'.repeat(400)}"></head></html>`)

    const meta = await fetchLinkMetadata('https://example.com/long')

    expect(meta.description).toHaveLength(280)
  })
})
