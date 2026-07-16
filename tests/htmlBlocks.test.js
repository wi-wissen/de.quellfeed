import { describe, expect, it } from 'vitest'
import {
  splitHtmlBlocks,
  planTranslationChunks,
  createHtmlBlockScanner,
} from '../src/utils/htmlBlocks.js'
import { normalizeLanguageTag } from '../src/utils/language.js'

describe('splitHtmlBlocks', () => {
  it('splits along top-level elements', () => {
    expect(splitHtmlBlocks('<p>One</p><h2>Two</h2><p>Three</p>')).toEqual([
      '<p>One</p>', '<h2>Two</h2>', '<p>Three</p>',
    ])
  })

  it('keeps bare top-level text as its own block', () => {
    expect(splitHtmlBlocks('just text')).toEqual(['just text'])
    expect(splitHtmlBlocks('<p>a</p>loose<p>b</p>')).toEqual(['<p>a</p>', 'loose', '<p>b</p>'])
  })

  it('never splits inside nested markup', () => {
    const html = '<blockquote><p>inner</p><p>more</p></blockquote>'
    expect(splitHtmlBlocks(html)).toEqual([html])
  })

  it('dissolves a wrapper div around the whole article into its paragraphs', () => {
    // Readability regularly hands over `<div class="page">…everything…</div>` —
    // split at that level, "paragraph-wise" would mean "the whole article at once".
    const html = '<div class="page"><p>One</p><h2>Two</h2><p>Three</p></div>'
    expect(splitHtmlBlocks(html)).toEqual(['<p>One</p>', '<h2>Two</h2>', '<p>Three</p>'])
  })

  it('dissolves nested wrappers all the way down', () => {
    const html = '<div><section><p>a</p></section><div><p>b</p></div></div>'
    expect(splitHtmlBlocks(html)).toEqual(['<p>a</p>', '<p>b</p>'])
  })

  it('keeps a div with only inline content whole — it behaves like a paragraph', () => {
    const html = '<div>text with <a href="#x">a link</a> inside</div>'
    expect(splitHtmlBlocks(html)).toEqual([html])
  })

  it('keeps loose text inside a dissolved wrapper as its own block', () => {
    expect(splitHtmlBlocks('<div><p>a</p>loose</div>')).toEqual(['<p>a</p>', 'loose'])
  })

  it('returns an empty list for empty input', () => {
    expect(splitHtmlBlocks('')).toEqual([])
    expect(splitHtmlBlocks(null)).toEqual([])
    expect(splitHtmlBlocks('   ')).toEqual([])
  })
})

describe('planTranslationChunks', () => {
  it('records where each chunk starts and how many blocks it covers', () => {
    const blocks = ['<p>aaaa</p>', '<p>bbbb</p>', '<p>cccc</p>']
    const plan = planTranslationChunks(blocks, 24)

    expect(plan.map(c => [c.start, c.count])).toEqual([[0, 2], [2, 1]])
    expect(plan.map(c => c.html).join('')).toBe(blocks.join(''))
  })

  it('lets an oversized single block travel alone instead of cutting it', () => {
    const big = `<p>${'x'.repeat(100)}</p>`
    const plan = planTranslationChunks([big, '<p>s</p>'], 24)

    expect(plan[0]).toEqual({ start: 0, count: 1, html: big })
    expect(plan[1].count).toBe(1)
  })
})

describe('createHtmlBlockScanner', () => {
  it('emits a block only once its closing tag has fully arrived', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('<p>Hal')).toEqual([])
    expect(scanner.scan('<p>Hallo</p')).toEqual([])
    expect(scanner.scan('<p>Hallo</p><h2>We')).toEqual(['<p>Hallo</p>'])
    expect(scanner.scan('<p>Hallo</p><h2>Welt</h2>')).toEqual(['<h2>Welt</h2>'])
  })

  it('tracks nesting — an inner closing tag does not end the block', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('<blockquote><p>a</p>')).toEqual([])
    expect(scanner.scan('<blockquote><p>a</p></blockquote>')).toEqual(['<blockquote><p>a</p></blockquote>'])
  })

  it('treats void elements as complete blocks and not as opened ones', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('<hr><p>text</p>')).toEqual(['<hr>', '<p>text</p>'])
  })

  it('does not mistake a ">" inside an attribute for the tag end', () => {
    const scanner = createHtmlBlockScanner()
    const html = '<img alt="a > b" src="x.jpg"><p>t</p>'

    expect(scanner.scan(html)).toEqual(['<img alt="a > b" src="x.jpg">', '<p>t</p>'])
  })

  it('skips a leading markdown fence and a trailing one', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('```html\n<p>Ha')).toEqual([])
    expect(scanner.scan('```html\n<p>Hallo</p>\n```')).toEqual(['<p>Hallo</p>'])
  })

  it('waits while the fence line itself is still streaming', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('```')).toEqual([])
    expect(scanner.scan('```html')).toEqual([])
    expect(scanner.scan('```html\n<p>a</p>')).toEqual(['<p>a</p>'])
  })

  it('emits top-level text once the next tag begins', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('loose text')).toEqual([]) // may still be growing
    expect(scanner.scan('loose text<p>a</p>')).toEqual(['loose text', '<p>a</p>'])
  })

  it('swallows comments and stray closing tags without emitting them', () => {
    const scanner = createHtmlBlockScanner()

    expect(scanner.scan('<!-- note --></div><p>a</p>')).toEqual(['<p>a</p>'])
  })
})

describe('normalizeLanguageTag', () => {
  it('reduces to the primary subtag', () => {
    expect(normalizeLanguageTag('de')).toBe('de')
    expect(normalizeLanguageTag('de-DE')).toBe('de')
    expect(normalizeLanguageTag('EN_us')).toBe('en')
    expect(normalizeLanguageTag('de-DE, en')).toBe('de')
  })

  it('answers "" for anything that is not a language tag', () => {
    expect(normalizeLanguageTag('')).toBe('')
    expect(normalizeLanguageTag(null)).toBe('')
    expect(normalizeLanguageTag('deutsch')).toBe('')
    expect(normalizeLanguageTag('123')).toBe('')
  })
})
