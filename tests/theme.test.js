import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { THEME_IDS, applyTheme, getThemePalette, getThemeState } from '../src/utils/theme.js'

const APP_CSS = readFileSync(join(process.cwd(), 'src', 'css', 'app.css'), 'utf8')

/** The `:root { … }` block at the top of app.css — the pre-theme.js defaults. */
const ROOT_BLOCK = APP_CSS.slice(APP_CSS.indexOf(':root'), APP_CSS.indexOf('}', APP_CSS.indexOf(':root')))

/**
 * Tokens that live in `:root` but deliberately are NOT per-theme, because they are derived
 * from one that is (or are sizes, not colours). Anything else in `:root` must exist in every
 * palette — otherwise switching the theme leaves the previous theme's value behind.
 */
const DERIVED_ROOT_TOKENS = ['--q-saved-bar', '--q-navbar-title-size', '--q-toolbar-label-size']

function hexToRgb(hex) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16))
}

/** Hue in degrees (0–360) and HSL saturation (0–1). */
function hueAndSaturation(hex) {
  const [r, g, b] = hexToRgb(hex).map(c => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2

  if (delta === 0) return { hue: 0, saturation: 0 }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue
  if (max === r) hue = 60 * (((g - b) / delta) % 6)
  else if (max === g) hue = 60 * ((b - r) / delta + 2)
  else hue = 60 * ((r - g) / delta + 4)

  return { hue: (hue + 360) % 360, saturation }
}

function hueDistance(a, b) {
  const raw = Math.abs(a - b) % 360
  return raw > 180 ? 360 - raw : raw
}

describe('theme palettes', () => {
  it('exposes every theme the appearance settings offer', () => {
    expect(THEME_IDS).toEqual(['light', 'dark', 'sepia', 'slate'])
  })

  // A missing key does not fall back to a default: applyTheme() sets the palette inline on
  // <html>, so a token one palette omits simply keeps the value the PREVIOUS theme wrote.
  it('defines exactly the same keys in every palette', () => {
    const reference = Object.keys(getThemePalette('light')).sort()
    expect(reference.length).toBeGreaterThan(0)

    for (const theme of THEME_IDS) {
      expect(Object.keys(getThemePalette(theme)).sort(), `palette "${theme}"`).toEqual(reference)
    }
  })

  it('keeps the :root defaults in app.css in step with the palettes', () => {
    const rootTokens = [...ROOT_BLOCK.matchAll(/(--q-[a-z-]+)\s*:/g)].map(m => m[1]).sort()
    const paletteTokens = Object.keys(getThemePalette('light'))
      .filter(key => key.startsWith('q-'))
      .map(key => `--${key}`)

    expect(rootTokens).toEqual([...paletteTokens, ...DERIVED_ROOT_TOKENS].sort())
  })
})

describe('the active tab is the primary colour in every theme', () => {
  // The tab bar's active tab is painted from --q-accent, twice: once through Framework7's
  // own variable (which its .md theme would otherwise point at --f7-md-on-secondary-container)
  // and once directly. Both must name the accent — never --q-text.
  it('binds the tab bar active colour to the accent token in app.css', () => {
    expect(APP_CSS).toMatch(/--f7-tabbar-link-active-color:\s*var\(--q-accent\)/)
    expect(APP_CSS).toMatch(/\.tabbar \.tab-link-active\s*\{[^}]*color:\s*var\(--q-accent\)/)
  })

  it('gives every theme an accent that is not the text colour', () => {
    for (const theme of THEME_IDS) {
      const palette = getThemePalette(theme)
      expect(palette['q-accent'], `palette "${theme}"`).not.toBe(palette['q-text'])
      expect(palette['q-accent'], `palette "${theme}"`).not.toBe(palette['q-text-muted'])
    }
  })

  /**
   * The regression this locks down. Sepia's accent used to be #8f5a2f — a brown sitting
   * right between its q-text (#452f20) and q-text-muted (#826a58): same hue, similar
   * saturation. Not *equal* to the text colour, so a !== check would have passed it, yet on
   * the device the selected tab was indistinguishable from a plain label.
   *
   * So the accent may not merely differ from the text tokens, it must be a different COLOUR:
   * another hue, or at least far more saturated. Every palette's blue clears this; the old
   * sepia brown does not.
   */
  it('gives every theme an accent that is not a shade of its text colour', () => {
    for (const theme of THEME_IDS) {
      const palette = getThemePalette(theme)
      const accent = hueAndSaturation(palette['q-accent'])

      for (const textToken of ['q-text', 'q-text-muted']) {
        const text = hueAndSaturation(palette[textToken])
        const differentHue = hueDistance(accent.hue, text.hue) > 30
        const muchMoreSaturated = accent.saturation - text.saturation > 0.25

        expect(
          differentHue || muchMoreSaturated,
          `"${theme}" accent ${palette['q-accent']} reads as a shade of its ${textToken} ${palette[textToken]}`,
        ).toBe(true)
      }
    }
  })
})

describe('applyTheme', () => {
  let root

  beforeEach(() => {
    root = document.createElement('html')
  })

  it('writes every palette token onto the root element', () => {
    for (const theme of THEME_IDS) {
      applyTheme(theme, root)

      for (const [token, value] of Object.entries(getThemePalette(theme))) {
        if (token === 'color-scheme') {
          expect(root.style.colorScheme).toBe(value)
          continue
        }
        expect(root.style.getPropertyValue(`--${token}`), `${theme}/${token}`).toBe(value)
      }
    }
  })

  // Every theme overwrites every token of the one before it — nothing bleeds through.
  it('leaves no token of the previous theme behind', () => {
    applyTheme('sepia', root)
    const sepiaAccent = root.style.getPropertyValue('--q-accent')

    applyTheme('dark', root)
    expect(root.style.getPropertyValue('--q-accent')).toBe(getThemePalette('dark')['q-accent'])
    expect(root.style.getPropertyValue('--q-accent')).not.toBe('')

    applyTheme('sepia', root)
    expect(root.style.getPropertyValue('--q-accent')).toBe(sepiaAccent)
  })

  it('toggles Framework7\'s .dark class from the palette, not from the theme name', () => {
    applyTheme('slate', root)
    expect(root.classList.contains('dark')).toBe(true)

    applyTheme('sepia', root)
    expect(root.classList.contains('dark')).toBe(false)
  })

  it('resolves an unknown theme to the light palette', () => {
    expect(getThemeState('nope').palette).toBe(getThemePalette('light'))
  })
})
