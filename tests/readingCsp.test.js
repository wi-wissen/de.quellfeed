import { describe, it, expect, afterEach } from 'vitest'
import { buildIframeDoc } from '../src/utils/articleParser.js'
import { applyTheme } from '../src/utils/theme.js'

function docFor(font) {
  return buildIframeDoc('<p>Hallo</p>', null, 'light', {
    reading: { font, fontSize: 1, width: 'normal' },
  })
}

function cspOf(html) {
  return html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || ''
}

/**
 * The reading view is a `srcdoc` iframe, so its document URL is `about:srcdoc`. A CSP
 * of `font-src 'self'` cannot be resolved against that and silently blocks our OWN
 * bundled fonts: the @font-face rule still applies (the family changes) but the woff2
 * never loads, so the text falls back to the next font in the stack. It looks like the
 * font switch works, and it does not.
 */
describe('the reading view CSP lets our own fonts through', () => {
  it('names the origin instead of relying on \'self\'', () => {
    const csp = cspOf(docFor('inter'))

    expect(csp).toContain(window.location.origin)
    expect(csp).not.toContain("'self'")
  })

  it('still blocks the article\'s own remote fonts', () => {
    const csp = cspOf(docFor('inter'))

    // Only our origin and data: — a font from the publisher's CDN has no way in.
    expect(csp).toMatch(/font-src [^;]*;/)
    expect(csp).not.toContain('*')
    expect(csp).not.toContain('https://fonts.googleapis.com')
  })

  it('still forbids scripts', () => {
    expect(cspOf(docFor('inter'))).toContain('script-src none')
  })

  it('embeds the @font-face whose family the stack actually asks for', () => {
    const html = docFor('inter')

    const declared = html.match(/@font-face\s*\{[^}]*font-family:\s*'([^']+)'/)?.[1]
    const stack = html.match(/--q-reading-font:\s*([^;]+);/)?.[1]

    // A mismatch here is invisible: the rule loads, nothing uses it, and the text
    // quietly renders in the fallback.
    expect(declared).toBeTruthy()
    expect(stack).toContain(`'${declared}'`)
  })

  it('embeds only the chosen font, not all of them', () => {
    const html = docFor('inter')

    expect((html.match(/@font-face/g) || []).length).toBe(1)
    expect(html).not.toContain('Special Elite')
  })

  it('embeds no @font-face at all for the system font', () => {
    expect(docFor('system')).not.toContain('@font-face')
  })
})

describe('applyTheme tells Framework7 about dark themes', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark')
  })

  // F7 hardcodes #000/#fff for segmented buttons, sheets and pickers and swaps them
  // only on a plain `.dark` class (bundle: 4536-4546). It never reads our data-theme,
  // so without this class those controls stay light in a dark theme.
  it('sets the .dark class for dark and slate', () => {
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    applyTheme('slate')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes it again for light and sepia', () => {
    applyTheme('dark')

    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    // Sepia is a *light* scheme with a warm background — F7's dark variants would be
    // wrong there.
    applyTheme('sepia')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
