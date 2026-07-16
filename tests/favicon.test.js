import { beforeEach, describe, expect, it } from 'vitest'
import {
  getFaviconFallbackUrl,
  getFaviconUrl,
  rememberDeclaredIcon,
  resetDeclaredIcons,
} from '../src/utils/favicon.js'

function docFrom(html) {
  return new DOMParser().parseFromString(html, 'text/html')
}

beforeEach(() => {
  resetDeclaredIcons()
})

/**
 * The icon used to come from Google's s2/favicons, which meant scrolling the feed list
 * told Google which sites the user reads — in an app that promises nothing leaves the
 * device. These tests exist to keep it that way.
 */
describe('getFaviconUrl', () => {
  it('asks the site itself, not a favicon service', () => {
    const url = getFaviconUrl('https://www.spektrum.de/news/123')

    expect(url).toBe('https://www.spektrum.de/favicon.ico')
    expect(url).not.toContain('google')
    expect(url).not.toContain('duckduckgo')
  })

  it('keeps the scheme of the page', () => {
    expect(getFaviconUrl('http://example.com/a')).toBe('http://example.com/favicon.ico')
  })

  it('returns null for anything that is not a URL', () => {
    expect(getFaviconUrl('not a url')).toBeNull()
    expect(getFaviconUrl('')).toBeNull()
    expect(getFaviconUrl(null)).toBeNull()
  })
})

describe('rememberDeclaredIcon', () => {
  it('prefers what the page declares over the guessed /favicon.ico', () => {
    rememberDeclaredIcon(
      'https://example.com/article',
      docFrom('<link rel="icon" href="/assets/icon.png">')
    )

    expect(getFaviconUrl('https://example.com/other')).toBe('https://example.com/assets/icon.png')
  })

  it('resolves a relative href against the page it came from', () => {
    rememberDeclaredIcon(
      'https://example.com/blog/post',
      docFrom('<link rel="shortcut icon" href="../icon.ico">')
    )

    expect(getFaviconUrl('https://example.com/x')).toBe('https://example.com/icon.ico')
  })

  it('takes the biggest declared icon — a 16px one is a smear at thumbnail size', () => {
    rememberDeclaredIcon(
      'https://example.com/a',
      docFrom(`
        <link rel="icon" href="/small.png" sizes="16x16">
        <link rel="icon" href="/big.png" sizes="180x180">
        <link rel="icon" href="/mid.png" sizes="32x32">
      `)
    )

    expect(getFaviconUrl('https://example.com/a')).toBe('https://example.com/big.png')
  })

  it('only remembers it for the host it came from', () => {
    rememberDeclaredIcon('https://example.com/a', docFrom('<link rel="icon" href="/i.png">'))

    expect(getFaviconUrl('https://other.example/a')).toBe('https://other.example/favicon.ico')
  })

  it('ignores a page that declares nothing, and never throws', () => {
    rememberDeclaredIcon('https://example.com/a', docFrom('<p>no icon here</p>'))
    expect(getFaviconUrl('https://example.com/a')).toBe('https://example.com/favicon.ico')

    expect(() => rememberDeclaredIcon('not a url', docFrom(''))).not.toThrow()
  })

  it('does not mistake a stylesheet for an icon', () => {
    rememberDeclaredIcon('https://example.com/a', docFrom('<link rel="stylesheet" href="/a.css">'))

    expect(getFaviconUrl('https://example.com/a')).toBe('https://example.com/favicon.ico')
  })
})

describe('getFaviconFallbackUrl', () => {
  // DuckDuckGo and not Google, because it 404s for a site it has no icon for instead of
  // handing back a generic globe that looks like a real icon.
  it('is the last resort, reached only after the site itself failed', () => {
    expect(getFaviconFallbackUrl('https://example.com/a')).toBe(
      'https://icons.duckduckgo.com/ip3/example.com.ico'
    )
  })

  it('returns null for anything that is not a URL', () => {
    expect(getFaviconFallbackUrl('nope')).toBeNull()
  })
})
