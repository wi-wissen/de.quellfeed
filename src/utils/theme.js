import { resolveReadingPrefs } from './fonts.js'

/**
 * One palette per theme, and every palette defines the SAME keys — tests/theme.test.js
 * enforces that, because a key missing from one palette does not fall back to a sane
 * default: it falls back to whatever the previous theme left on the root element, or to
 * a hardcoded Framework7 colour.
 *
 * `q-accent` is the app's ONE primary colour. Everything that says "this is active,
 * interactive or ours" is painted from it: the tab bar's active tab
 * (--f7-tabbar-link-active-color), filled buttons, focused inputs, links in the reading
 * view, the saved marker. It is therefore the one token that must never be a shade of
 * `q-text` — an active tab painted in the text colour is not readable as active at all.
 *
 * That is exactly what sepia used to do: its accent was #8f5a2f, a brown sitting between
 * q-text (#452f20) and q-text-muted (#826a58), so the selected tab looked like plain
 * label text while the light theme's blue obviously did not. Sepia now carries the same
 * brand blue as the light theme — sepia tints the *paper*, not the primary — so the
 * active selection reads identically in every theme. Dark and slate lighten that same
 * blue purely for contrast against their backgrounds.
 *
 * `q-accent-rgb` is the accent's channels for --f7-theme-color-rgb, which Framework7 uses
 * wherever it needs the theme colour at partial alpha (ripples, highlights). It used to be
 * a hardcoded blue in app.css and stayed blue in every theme.
 */
const THEME_PALETTES = {
  light: {
    'q-accent': '#1d3d8f',
    'q-accent-rgb': '29, 61, 143',
    'q-text': '#172033',
    'q-text-muted': '#617089',
    'q-bg': '#ffffff',
    'q-surface': '#ffffff',
    'q-surface-elevated': '#ffffff',
    'q-border': '#dde3ec',
    'q-bar-bg': '#ffffff',
    'q-bar-border': 'rgba(137, 154, 179, 0.22)',
    'q-input-bg': '#ffffff',
    'q-shadow': '0 18px 40px rgba(23, 32, 51, 0.05)',
    'q-danger': '#b42318',
    'q-warning': '#d97706',
    'q-success': '#11795a',
    'color-scheme': 'light',
  },
  dark: {
    'q-accent': '#7ea2ff',
    'q-accent-rgb': '126, 162, 255',
    'q-text': '#f5f7fb',
    'q-text-muted': '#8f98a8',
    'q-bg': '#000000',
    'q-surface': '#050505',
    'q-surface-elevated': '#0a0a0a',
    'q-border': '#171717',
    'q-bar-bg': '#000000',
    'q-bar-border': 'rgba(255, 255, 255, 0.08)',
    'q-input-bg': '#0a0a0a',
    'q-shadow': '0 16px 36px rgba(0, 0, 0, 0.58)',
    'q-danger': '#ff8f7a',
    'q-warning': '#f5a524',
    'q-success': '#67d6b3',
    'color-scheme': 'dark',
  },
  sepia: {
    'q-accent': '#1d3d8f',
    'q-accent-rgb': '29, 61, 143',
    'q-text': '#452f20',
    'q-text-muted': '#826a58',
    'q-bg': '#f6efe1',
    'q-surface': '#eadfc7',
    'q-surface-elevated': '#fff8ed',
    'q-border': '#dbc9af',
    'q-bar-bg': 'rgba(255, 248, 237, 0.9)',
    'q-bar-border': 'rgba(143, 90, 47, 0.18)',
    'q-input-bg': 'rgba(255, 252, 245, 0.94)',
    'q-shadow': '0 24px 58px rgba(122, 94, 61, 0.12)',
    'q-danger': '#b14a2e',
    'q-warning': '#b45309',
    'q-success': '#6c7a2a',
    'color-scheme': 'light',
  },
  slate: {
    'q-accent': '#9cb6ff',
    'q-accent-rgb': '156, 182, 255',
    'q-text': '#f7f7f8',
    'q-text-muted': '#b3b3b8',
    'q-bg': '#161618',
    'q-surface': '#232327',
    'q-surface-elevated': '#1e1f23',
    'q-border': '#303238',
    'q-bar-bg': 'rgba(22, 22, 24, 0.9)',
    'q-bar-border': 'rgba(156, 182, 255, 0.14)',
    'q-input-bg': 'rgba(30, 31, 35, 0.96)',
    'q-shadow': '0 24px 60px rgba(0, 0, 0, 0.36)',
    'q-danger': '#ff9b7c',
    'q-warning': '#f0b357',
    'q-success': '#76d8b0',
    'color-scheme': 'dark',
  },
}

export const THEME_IDS = Object.keys(THEME_PALETTES)

export function getThemePalette(theme) {
  return THEME_PALETTES[theme] || null
}

export function resolveThemeChoice(choice = 'system') {
  if (choice && choice !== 'system') return choice
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

export function getThemeState(choice = 'system') {
  const resolved = resolveThemeChoice(choice)
  return {
    choice,
    resolved,
    palette: THEME_PALETTES[resolved] || THEME_PALETTES.light,
  }
}

export function applyTheme(choice = 'system', root = document.documentElement) {
  const state = getThemeState(choice)

  root.dataset.themeChoice = choice
  root.dataset.theme = state.resolved

  // Framework7 does not read our data-theme. It switches its own dark variants on a
  // plain `.dark` class (bundle: 4544-4546 for segmented, and dozens of others), and
  // for the components where it hardcodes #000/#fff — segmented, sheets, pickers —
  // that class is the ONLY way in. Without it they stay light in a dark theme.
  root.classList.toggle('dark', state.palette['color-scheme'] === 'dark')

  Object.entries(state.palette).forEach(([token, value]) => {
    if (token === 'color-scheme') {
      root.style.colorScheme = value
      return
    }
    root.style.setProperty(`--${token}`, value)
  })

  // For the NEXT cold start: index.html paints this synchronously before the bundle
  // even loads. localStorage, not our async storage — this must be readable in the
  // first milliseconds, which is the whole point.
  try {
    window.localStorage?.setItem('quell:lastBg', state.palette['q-bg'])
  } catch {
    // Storage full or blocked — the prefers-color-scheme fallback in index.html holds.
  }

  return state
}

/**
 * CSS for the reading view iframe: color tokens plus the chosen font.
 *
 * `readingPrefs` is optional — without it the defaults from fonts.js apply
 * (system font, factor 1), so existing callers keep working unchanged. The
 * `@font-face` rules must be emitted here too, because the iframe is a
 * `srcdoc` with no stylesheet link and does not inherit the app's fonts.
 *
 * `--q-reading-font-size` is deliberately an `em` value, not a px number: this
 * way the reading view follows the device's system font size. The value
 * already includes the font's `sizeFactor` (user factor × sizeFactor).
 *
 * `--q-reading-width` is a `ch` value for the same reason: the column is
 * measured in *characters*, not pixels, and therefore grows automatically
 * with font and font size.
 */
export function buildReadingThemeCss(choice = 'system', readingPrefs = {}) {
  const { palette } = getThemeState(choice)
  const reading = resolveReadingPrefs(readingPrefs)

  return `
    ${reading.faces}
    :root {
      --q-accent: ${palette['q-accent']};
      --q-text: ${palette['q-text']};
      --q-text-muted: ${palette['q-text-muted']};
      --q-bg: ${palette['q-bg']};
      --q-surface: ${palette['q-surface']};
      --q-border: ${palette['q-border']};
      --q-reading-font: ${reading.stack};
      --q-reading-font-size: ${reading.fontSizeEm}em;
      --q-reading-width: ${reading.widthValue};
      color-scheme: ${palette['color-scheme']};
    }
  `
}