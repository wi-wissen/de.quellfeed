import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_READING_FONT_SCALE,
  DEFAULT_READING_WIDTH,
  MAX_READING_FONT_SCALE,
  MIN_READING_FONT_SCALE,
  READING_FONTS,
  READING_FONTS_STYLE_ID,
  READING_FONT_SCALES,
  READING_FONT_SCALE_VALUES,
  READING_FONT_SIZE_FACTORS,
  READING_WIDTHS,
  READING_WIDTH_IDS,
  buildAllFontFaceCss,
  buildFontFaceCss,
  getFontSizeFactor,
  getReadingWidth,
  injectReadingFonts,
  resolveFontScale,
  resolveFontSizeEm,
  resolveFontSizePx,
  resolveFontStack,
  resolveReadingPrefs,
  resolveReadingWidth,
  resolveReadingWidthValue,
} from '../src/utils/fonts.js'
import { buildReadingThemeCss } from '../src/utils/theme.js'
import { buildIframeDoc } from '../src/utils/articleParser.js'

const OTHER_FONT_KEYS = {
  literata: ['inter', 'cause', 'opendyslexic', 'playwrite-de', 'special-elite'],
}

/** Schriften, die es einmal gab und die nicht mehr gebündelt werden dürfen. */
const REMOVED_FONTS = ['lexend', 'tangerine']

describe('READING_FONTS', () => {
  it('exposes the seven selectable fonts with stable ids', () => {
    expect(READING_FONTS.map(font => font.id)).toEqual([
      'system',
      'opendyslexic',
      'inter',
      'literata',
      'cause',
      'special-elite',
      'playwrite-de',
    ])
  })

  it('no longer offers Lexend or Tangerine', () => {
    for (const removed of REMOVED_FONTS) {
      expect(READING_FONTS.map(font => font.id), removed).not.toContain(removed)
    }
  })

  it('gives every font a non-empty stack and a label', () => {
    for (const font of READING_FONTS) {
      expect(resolveFontStack(font.id), font.id).toBeTruthy()
      expect(font.label, font.id).toBeTruthy()
    }
  })

  it('falls back to the system stack for an unknown id', () => {
    const systemStack = resolveFontStack('system')

    expect(resolveFontStack('does-not-exist')).toBe(systemStack)
    expect(resolveFontStack('lexend')).toBe(systemStack)
    expect(resolveFontStack('tangerine')).toBe(systemStack)
    expect(resolveFontStack(undefined)).toBe(systemStack)
    expect(resolveFontStack(null)).toBe(systemStack)
    expect(systemStack).toContain('-apple-system')
  })
})

describe('size factors', () => {
  it('exposes a factor per font id for the selection UI', () => {
    expect(Object.keys(READING_FONT_SIZE_FACTORS)).toEqual(READING_FONTS.map(font => font.id))
    for (const font of READING_FONTS) {
      expect(READING_FONT_SIZE_FACTORS[font.id], font.id).toBeGreaterThan(0)
    }
  })

  it('compensates only fonts that need it and leaves the others alone', () => {
    expect(getFontSizeFactor('playwrite-de')).toBe(1)
    expect(getFontSizeFactor('opendyslexic')).toBeLessThan(1)
    expect(getFontSizeFactor('inter')).toBe(1)
    expect(getFontSizeFactor('system')).toBe(1)
  })

  it('falls back to the system factor for an unknown id', () => {
    expect(getFontSizeFactor('does-not-exist')).toBe(1)
    expect(getFontSizeFactor('tangerine')).toBe(1)
  })
})

describe('buildFontFaceCss', () => {
  it('embeds nothing for the system font', () => {
    expect(buildFontFaceCss('system')).toBe('')
    expect(buildFontFaceCss('unknown-font')).toBe('')
  })

  it('emits a @font-face rule with a src for a bundled font', () => {
    const css = buildFontFaceCss('inter')

    expect(css).toContain('@font-face')
    expect(css).toContain('src:')
    expect(css).toContain('.woff2')
    expect(css).toContain("font-family: 'Inter Variable'")
  })

  it('emits every weight of a static multi-weight font', () => {
    const css = buildFontFaceCss('opendyslexic')

    expect(css.match(/@font-face/g)).toHaveLength(2)
    expect(css).toContain('font-weight: 400')
    expect(css).toContain('font-weight: 700')
  })

  it('embeds only the selected font, not all of them', () => {
    const css = buildFontFaceCss('literata')

    expect(css).toContain('literata')
    for (const other of OTHER_FONT_KEYS.literata) {
      expect(css, `${other} must not be embedded`).not.toContain(other)
    }
  })

  it('falls back to the system font for a removed font id', () => {
    for (const removed of REMOVED_FONTS) {
      expect(buildFontFaceCss(removed), removed).toBe('')
    }
  })
})

describe('buildAllFontFaceCss', () => {
  it('contains a face for every bundled font', () => {
    const css = buildAllFontFaceCss()

    for (const font of READING_FONTS) {
      if (font.id === 'system') continue
      expect(css, font.id).toContain(font.id)
    }
  })

  it('emits one @font-face per bundled weight, not one per font', () => {
    const css = buildAllFontFaceCss()
    // 6 Schriften ohne System, davon eine mit zwei Schnitten (OpenDyslexic).
    expect(css.match(/@font-face/g)).toHaveLength(7)
  })

  it('does not bundle the removed fonts any more', () => {
    const css = buildAllFontFaceCss().toLowerCase()

    for (const removed of REMOVED_FONTS) {
      expect(css, removed).not.toContain(removed)
    }
  })

  it('never points at a remote origin', () => {
    const css = buildAllFontFaceCss()

    expect(css).not.toContain('//fonts.googleapis')
    expect(css).not.toContain('//fonts.gstatic')
    expect(css).toContain('.woff2')
  })
})

describe('injectReadingFonts', () => {
  beforeEach(() => {
    document.getElementById(READING_FONTS_STYLE_ID)?.remove()
  })

  it('appends a single style tag carrying all faces', () => {
    const style = injectReadingFonts(document)

    expect(style).toBeTruthy()
    expect(style.id).toBe(READING_FONTS_STYLE_ID)
    expect(document.head.contains(style)).toBe(true)
    expect(style.textContent).toContain('@font-face')
    expect(style.textContent).toContain('Playwrite DE VA')
    expect(style.textContent).toContain('OpenDyslexic')
  })

  it('is idempotent — a second call does not insert a second tag', () => {
    const first = injectReadingFonts(document)
    const second = injectReadingFonts(document)
    const third = injectReadingFonts()

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(document.querySelectorAll(`#${READING_FONTS_STYLE_ID}`)).toHaveLength(1)
    expect(document.head.querySelectorAll('style').length).toBeGreaterThan(0)
  })

  it('defaults to the app document and tolerates a headless document', () => {
    expect(injectReadingFonts(null)).toBeNull()
    expect(injectReadingFonts({})).toBeNull()
  })
})

describe('READING_FONT_SCALES', () => {
  it('is a geometric ladder of five steps with 100 % exactly in the middle', () => {
    expect(READING_FONT_SCALE_VALUES).toEqual([0.76, 0.87, 1, 1.15, 1.32])
    expect(READING_FONT_SCALES.map(step => step.percent)).toEqual([76, 87, 100, 115, 132])
    expect(READING_FONT_SCALES).toHaveLength(5)
    expect(READING_FONT_SCALE_VALUES[2]).toBe(1)
    expect(DEFAULT_READING_FONT_SCALE).toBe(1)
    expect(MIN_READING_FONT_SCALE).toBe(0.76)
    expect(MAX_READING_FONT_SCALE).toBe(1.32)
  })

  it('steps by a constant factor of ~1.15 rather than by constant addition', () => {
    for (let i = 1; i < READING_FONT_SCALE_VALUES.length; i += 1) {
      const ratio = READING_FONT_SCALE_VALUES[i] / READING_FONT_SCALE_VALUES[i - 1]
      expect(ratio, `step ${i}`).toBeCloseTo(1.15, 1)
    }
  })

  it('is symmetric around 100 % — min × max ≈ 1', () => {
    expect(MIN_READING_FONT_SCALE * MAX_READING_FONT_SCALE).toBeCloseTo(1, 1)
  })

  it('holds no pixel values at all', () => {
    for (const step of READING_FONT_SCALES) {
      expect(step.value, `${step.value} looks like px`).toBeLessThan(3)
      expect(step.percent).toBe(Math.round(step.value * 100))
    }
  })
})

describe('resolveFontScale', () => {
  it('keeps the allowed steps untouched', () => {
    for (const scale of READING_FONT_SCALE_VALUES) {
      expect(resolveFontScale(scale)).toBe(scale)
    }
  })

  it('falls back to the default for garbage input', () => {
    for (const value of [null, undefined, 'abc', NaN, {}, [], Infinity, 0, -3]) {
      expect(resolveFontScale(value)).toBe(DEFAULT_READING_FONT_SCALE)
    }
  })

  it('clamps out-of-range factors into the allowed range', () => {
    expect(resolveFontScale(0.1)).toBe(MIN_READING_FONT_SCALE)
    expect(resolveFontScale(2.9)).toBe(MAX_READING_FONT_SCALE)
  })

  it('snaps in-between factors onto the nearest step', () => {
    expect(resolveFontScale(1.1)).toBe(1.15)
    expect(resolveFontScale(0.8)).toBe(0.76)
    expect(resolveFontScale(0.92)).toBe(0.87)
    expect(resolveFontScale('1.15')).toBe(1.15)
    expect(READING_FONT_SCALE_VALUES).toContain(resolveFontScale(1.24))
  })

  it('migrates the legacy pixel sizes onto the new ladder', () => {
    // Allererste Version: [15, 16, 17, 19, 21, 24] px, 17 = 100 %.
    expect(resolveFontScale(15)).toBe(0.87)
    expect(resolveFontScale(16)).toBe(1)
    expect(resolveFontScale(17)).toBe(1)
    expect(resolveFontScale(19)).toBe(1.15)
    expect(resolveFontScale(21)).toBe(1.32)
    expect(resolveFontScale(24)).toBe(1.32)
  })

  it('migrates the previous relative ladder onto the new one', () => {
    // Ausgelieferte Zwischenversion: [0.85, 1, 1.15, 1.3, 1.5].
    expect(resolveFontScale(0.85)).toBe(0.87)
    expect(resolveFontScale(1)).toBe(1)
    expect(resolveFontScale(1.15)).toBe(1.15)
    expect(resolveFontScale(1.3)).toBe(1.32)
    expect(resolveFontScale(1.5)).toBe(1.32)
  })

  it('never turns a legacy value of either format into nonsense', () => {
    const legacy = [15, 16, 17, 19, 21, 24, 12, 40, '21', 0.85, 1, 1.15, 1.3, 1.5, '1.3']
    for (const value of legacy) {
      expect(READING_FONT_SCALE_VALUES, String(value)).toContain(resolveFontScale(value))
    }
  })
})

describe('resolveFontSizeEm', () => {
  it('leaves fonts without a size factor at their nominal factor', () => {
    expect(resolveFontSizeEm('inter', 1)).toBe(1)
    expect(resolveFontSizeEm('system', 1.32)).toBe(1.32)
  })

  it('multiplies the user factor with the font size factor', () => {
    expect(resolveFontSizeEm('playwrite-de', 1)).toBe(1)
    expect(resolveFontSizeEm('playwrite-de', 1.15)).toBeCloseTo(1.15, 3)
    expect(resolveFontSizeEm('opendyslexic', 1)).toBe(0.95)
  })

  it('applies the migration before multiplying, so legacy px still works', () => {
    expect(resolveFontSizeEm('playwrite-de', 17)).toBe(resolveFontSizeEm('playwrite-de', 1))
    expect(resolveFontSizeEm('inter', 24)).toBe(1.32)
  })

  it('offers a px helper for previews in the app document', () => {
    expect(resolveFontSizePx('inter', 1, 16)).toBe(16)
    expect(resolveFontSizePx('playwrite-de', 1, 16)).toBe(16)
  })
})

describe('READING_WIDTHS', () => {
  it('exposes three ch-based steps with speaking ids and no baked-in label', () => {
    expect(READING_WIDTH_IDS).toEqual(['narrow', 'normal', 'wide'])
    expect(READING_WIDTHS.map(width => width.value)).toEqual(['55ch', '65ch', '75ch'])
    expect(DEFAULT_READING_WIDTH).toBe('normal')

    for (const width of READING_WIDTHS) {
      expect(width.label, width.id).toBeUndefined()
    }
  })

  it('stays inside the 45–75 characters-per-line rule of thumb', () => {
    for (const width of READING_WIDTHS) {
      expect(width.ch, width.id).toBeGreaterThanOrEqual(45)
      expect(width.ch, width.id).toBeLessThanOrEqual(75)
      expect(width.value).toBe(`${width.ch}ch`)
    }
  })

  it('never uses pixels', () => {
    for (const width of READING_WIDTHS) {
      expect(width.value, width.id).not.toContain('px')
    }
  })
})

describe('resolveReadingWidth', () => {
  it('keeps the known ids', () => {
    for (const id of READING_WIDTH_IDS) {
      expect(resolveReadingWidth(id)).toBe(id)
    }
  })

  it('falls back to normal for anything unknown', () => {
    for (const value of [undefined, null, '', 'huge', 680, '65ch', {}, NaN]) {
      expect(resolveReadingWidth(value), String(value)).toBe(DEFAULT_READING_WIDTH)
    }
  })

  it('resolves the id into the css value', () => {
    expect(resolveReadingWidthValue('narrow')).toBe('55ch')
    expect(resolveReadingWidthValue('normal')).toBe('65ch')
    expect(resolveReadingWidthValue('wide')).toBe('75ch')
    expect(resolveReadingWidthValue('nonsense')).toBe('65ch')
  })

  it('returns the whole entry via getReadingWidth', () => {
    expect(getReadingWidth('wide')).toEqual({ id: 'wide', ch: 75, value: '75ch' })
    expect(getReadingWidth('nope').id).toBe('normal')
  })
})

describe('resolveReadingPrefs', () => {
  it('normalises garbage into usable defaults', () => {
    const prefs = resolveReadingPrefs({ font: 'nope', fontSize: 'abc', width: 'nope' })

    expect(prefs.font).toBe('system')
    expect(prefs.fontScale).toBe(DEFAULT_READING_FONT_SCALE)
    expect(prefs.fontSize).toBe(DEFAULT_READING_FONT_SCALE)
    expect(prefs.fontSizeEm).toBe(1)
    expect(prefs.sizeFactor).toBe(1)
    expect(prefs.faces).toBe('')
    expect(prefs.stack).toContain('-apple-system')
    expect(prefs.width).toBe('normal')
    expect(prefs.widthValue).toBe('65ch')
  })

  it('works without any argument at all', () => {
    expect(resolveReadingPrefs().font).toBe('system')
    expect(resolveReadingPrefs().fontScale).toBe(1)
    expect(resolveReadingPrefs().width).toBe('normal')
    expect(resolveReadingPrefs().widthValue).toBe('65ch')
  })

  it('carries the chosen width through', () => {
    expect(resolveReadingPrefs({ width: 'narrow' }).widthValue).toBe('55ch')
    expect(resolveReadingPrefs({ width: 'wide' }).widthValue).toBe('75ch')
    expect(resolveReadingPrefs({ width: 'wide' }).widthCh).toBe(75)
  })

  it('drops a removed font back to the system font', () => {
    expect(resolveReadingPrefs({ font: 'lexend' }).font).toBe('system')
    expect(resolveReadingPrefs({ font: 'tangerine' }).faces).toBe('')
  })

  it('migrates a persisted legacy pixel size', () => {
    const prefs = resolveReadingPrefs({ font: 'literata', fontSize: 21 })

    expect(prefs.fontScale).toBe(1.32)
    expect(prefs.fontSizeEm).toBe(1.32)
  })

  it('migrates a persisted value of the previous relative ladder', () => {
    expect(resolveReadingPrefs({ font: 'inter', fontSize: 0.85 }).fontScale).toBe(0.87)
    expect(resolveReadingPrefs({ font: 'inter', fontSize: 1.5 }).fontScale).toBe(1.32)
  })

  it('carries the size factor of the chosen font', () => {
    const prefs = resolveReadingPrefs({ font: 'opendyslexic', fontSize: 1 })

    expect(prefs.sizeFactor).toBe(0.95)
    expect(prefs.fontSizeEm).toBe(0.95)
  })
})

describe('buildReadingThemeCss', () => {
  it('still works without reading prefs and defaults to the system font', () => {
    const css = buildReadingThemeCss('light')

    expect(css).toContain('--q-accent:')
    expect(css).toContain('--q-reading-font:')
    expect(css).toContain('--q-reading-font-size: 1em')
    expect(css).toContain('--q-reading-width: 65ch')
    expect(css).not.toContain('@font-face')
  })

  it('emits the font variables and faces for the chosen font', () => {
    const css = buildReadingThemeCss('dark', { font: 'literata', fontSize: 1.15 })

    expect(css).toContain('@font-face')
    expect(css).toContain('--q-reading-font: \'Literata Variable\'')
    expect(css).toContain('--q-reading-font-size: 1.15em')
    expect(css).toContain('--q-text:')
  })

  it('never emits a pixel font size or a pixel width any more', () => {
    const css = buildReadingThemeCss('light', { font: 'inter', fontSize: 1.15, width: 'wide' })

    expect(css).not.toMatch(/--q-reading-font-size:\s*[\d.]+px/)
    expect(css).not.toMatch(/--q-reading-width:\s*[\d.]+px/)
    expect(css).toContain('--q-reading-font-size: 1.15em')
    expect(css).toContain('--q-reading-width: 75ch')
  })

  it('emits the chosen reading width', () => {
    expect(buildReadingThemeCss('light', { width: 'narrow' })).toContain('--q-reading-width: 55ch')
    expect(buildReadingThemeCss('light', { width: 'bogus' })).toContain('--q-reading-width: 65ch')
  })

  it('applies the size factor of the chosen font', () => {
    const css = buildReadingThemeCss('light', { font: 'opendyslexic', fontSize: 1 })

    expect(css).not.toContain('--q-reading-font-size: 1em')
    expect(css).toContain(`--q-reading-font-size: ${resolveFontSizeEm('opendyslexic', 1)}em`)
  })
})

describe('buildIframeDoc reading prefs', () => {
  // This test used to assert `font-src 'self'` — and thereby pinned the bug in place.
  // The reading view is a `srcdoc` iframe, whose document URL is `about:srcdoc`, and
  // `'self'` cannot be resolved against that: our own bundled fonts were blocked. The
  // @font-face rule still applied, so the family changed and the text quietly rendered
  // in the fallback — a font switch that looked like it worked and did not.
  it('names our origin so our own fonts load, while remote fonts stay blocked', () => {
    const doc = buildIframeDoc('<p>Body</p>')
    const csp = doc.match(/Content-Security-Policy" content="([^"]*)"/)[1]

    expect(csp).toContain(window.location.origin)
    expect(csp).not.toContain("'self'")
    expect(csp).toContain('data:')
    expect(csp).toContain('script-src none')
    expect(csp).not.toContain('font-src none')
    expect(csp).not.toContain('*')
  })

  it('renders the body with the font custom properties instead of hardcoded values', () => {
    const doc = buildIframeDoc('<p>Body</p>')

    expect(doc).toContain('font-family: var(--q-reading-font')
    expect(doc).toContain('font-size: var(--q-reading-font-size, 1em)')
  })

  it('drives the column width off the custom property, no hardcoded 680px', () => {
    const doc = buildIframeDoc('<p>Body</p>')

    expect(doc).toContain('max-width: var(--q-reading-width, 65ch)')
    expect(doc).not.toContain('max-width: 680px')
  })

  it('keeps the title in em so it follows the body size', () => {
    const doc = buildIframeDoc('<p>Body</p>', null, 'light', { title: 'T', showArticleTitle: true })

    expect(doc).toContain('font-size: clamp(1.9em, 1.55em + 1vw, 2.7em)')
  })

  it('passes options.reading through into the document styles', () => {
    const doc = buildIframeDoc('<p>Body</p>', null, 'dark', {
      reading: { font: 'literata', fontSize: 1.32, width: 'narrow' },
    })

    expect(doc).toContain('@font-face')
    expect(doc).toContain('literata')
    expect(doc).toContain('--q-reading-font-size: 1.32em')
    expect(doc).toContain('--q-reading-width: 55ch')
  })

  it('embeds only the selected font, never all of them', () => {
    const doc = buildIframeDoc('<p>Body</p>', null, 'dark', {
      reading: { font: 'literata', fontSize: 1 },
    })

    expect(doc.match(/@font-face/g)).toHaveLength(1)
    for (const other of OTHER_FONT_KEYS.literata) {
      expect(doc, `${other} must not be embedded`).not.toContain(`${other}-latin`)
    }
  })

  it('keeps working when no reading prefs are given', () => {
    const doc = buildIframeDoc('<p>Body</p>')

    expect(doc).not.toContain('@font-face')
    expect(doc).toContain('--q-reading-font-size: 1em')
    expect(doc).toContain('--q-reading-width: 65ch')
  })

  it('migrates a legacy pixel size coming from persisted settings', () => {
    const doc = buildIframeDoc('<p>Body</p>', null, 'light', {
      reading: { font: 'inter', fontSize: 19 },
    })

    expect(doc).toContain('--q-reading-font-size: 1.15em')
    expect(doc).not.toContain('19px')
  })
})
