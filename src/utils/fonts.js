/**
 * Reading view fonts, font sizes, and reading widths.
 *
 * The reading view runs inside a `srcdoc` iframe with no stylesheet link, so the
 * Fontsource CSS files cannot simply be imported — they would end up in the main
 * document, not in the iframe. Instead we only import the .woff2 files (Vite
 * `?url`) and write the `@font-face` rules ourselves into the iframe's `<style>`.
 *
 * Only the *selected* font is ever embedded into the reading view, never all of
 * them. For picker UIs in the app document that show every font in itself, use
 * `injectReadingFonts()` / `buildAllFontFaceCss()`.
 */

import openDyslexic400Url from '@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?url'
import openDyslexic700Url from '@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?url'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import literataUrl from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url'
import causeUrl from '@fontsource-variable/cause/files/cause-latin-wght-normal.woff2?url'
import specialElite400Url from '@fontsource/special-elite/files/special-elite-latin-400-normal.woff2?url'
import interExtUrl from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url'
import literataExtUrl from '@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url'
import causeExtUrl from '@fontsource-variable/cause/files/cause-latin-ext-wght-normal.woff2?url'
import specialEliteExtUrl from '@fontsource/special-elite/files/special-elite-latin-ext-400-normal.woff2?url'
import playwrite400Url from '@fontsource/playwrite-de-va/files/playwrite-de-va-latin-400-normal.woff2?url'

const SYSTEM_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'

export const DEFAULT_READING_FONT = 'system'

/**
 * The iframe inherits the main document's base URL, so relative font paths
 * would resolve there in principle. We make them absolute anyway so they stay
 * stable regardless of any <base> that might get set in the srcdoc — and so
 * they reliably count as same-origin under the CSP `font-src 'self' data:`.
 */
function toAbsoluteUrl(url) {
  if (!url) return ''
  if (/^(https?:|data:|blob:|file:)/i.test(url)) return url
  if (typeof window === 'undefined' || !window.location) return url
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

/**
 * Fontsource's subset ranges. `latin` alone has ä/ö/ü/ß, but not the ř in Dvořák, the
 * Ł in Łódź or the ő in Erdős — names that turn up in German articles all the time. A
 * missing glyph falls back to another font mid-word. The latin-ext face fills that gap;
 * thanks to `unicode-range` it is only loaded when such a character is on the page.
 */
const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT_RANGE =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

function face(family, url, weight, format, unicodeRange) {
  return `
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-display: swap;
  font-weight: ${weight};
  src: url(${toAbsoluteUrl(url)}) format('${format}');${unicodeRange ? `\n  unicode-range: ${unicodeRange};` : ''}
}`.trim()
}

/** Variable font: one file covers the whole `wght` axis. `extUrl`: the latin-ext subset. */
function variableFace(family, url, weightRange, extUrl = null) {
  if (!extUrl) return face(family, url, weightRange, 'woff2-variations')
  return joinFaces(
    face(family, url, weightRange, 'woff2-variations', LATIN_RANGE),
    face(family, extUrl, weightRange, 'woff2-variations', LATIN_EXT_RANGE),
  )
}

/** Static font: one file per weight. `extUrl`: the latin-ext subset. */
function staticFace(family, url, weight, extUrl = null) {
  if (!extUrl) return face(family, url, weight, 'woff2')
  return joinFaces(
    face(family, url, weight, 'woff2', LATIN_RANGE),
    face(family, extUrl, weight, 'woff2', LATIN_EXT_RANGE),
  )
}

function joinFaces(...faces) {
  return faces.join('\n')
}

/**
 * `sizeFactor` compensates for fonts that look noticeably smaller (or larger)
 * than a normal text font at the same px size. Playwrite has a small x-height
 * (a schoolbook handwriting model), OpenDyslexic runs large.
 */
export const READING_FONTS = [
  {
    id: 'system',
    label: 'System',
    stack: SYSTEM_STACK,
    sizeFactor: 1,
    get faces() {
      return ''
    },
  },
  {
    id: 'opendyslexic',
    label: 'OpenDyslexic',
    stack: `'OpenDyslexic', ${SYSTEM_STACK}`,
    sizeFactor: 0.95,
    get faces() {
      return joinFaces(
        staticFace('OpenDyslexic', openDyslexic400Url, 400),
        staticFace('OpenDyslexic', openDyslexic700Url, 700),
      )
    },
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: `'Inter Variable', ${SYSTEM_STACK}`,
    sizeFactor: 1,
    get faces() {
      return variableFace('Inter Variable', interUrl, '100 900', interExtUrl)
    },
  },
  {
    id: 'literata',
    label: 'Literata',
    stack: `'Literata Variable', Georgia, 'Times New Roman', serif`,
    sizeFactor: 1,
    get faces() {
      return variableFace('Literata Variable', literataUrl, '200 900', literataExtUrl)
    },
  },
  {
    id: 'cause',
    label: 'Cause',
    stack: `'Cause Variable', ${SYSTEM_STACK}`,
    sizeFactor: 1,
    get faces() {
      return variableFace('Cause Variable', causeUrl, '100 900', causeExtUrl)
    },
  },
  {
    id: 'special-elite',
    label: 'Special Elite',
    stack: `'Special Elite', ui-monospace, 'Courier New', monospace`,
    sizeFactor: 1,
    get faces() {
      return staticFace('Special Elite', specialElite400Url, 400, specialEliteExtUrl)
    },
  },
  {
    // Playwrite DE VA — the German (Vereinfachte Ausgangsschrift) member of
    // Google's Playwrite family of school-handwriting fonts. Renders large enough
    // at nominal size (checked on device) — no compensation factor.
    id: 'playwrite-de',
    label: 'Playwrite',
    stack: `'Playwrite DE VA', cursive`,
    sizeFactor: 1,
    get faces() {
      return staticFace('Playwrite DE VA', playwrite400Url, 400)
    },
  },
]

export const READING_FONT_IDS = READING_FONTS.map(font => font.id)

/** `{ [fontId]: sizeFactor }` — for UI lists that want to visually match every font. */
export const READING_FONT_SIZE_FACTORS = Object.fromEntries(
  READING_FONTS.map(font => [font.id, font.sizeFactor]),
)

/**
 * Font size is a *relative* factor, not a pixel count: 1 = normal reading size.
 * In the iframe this becomes an `em` value on the body, which then follows the
 * device's system font size (accessibility).
 *
 * The ladder is a *geometric* series with a step factor of 1.15 and 100% as the
 * exact middle: 1/1.15² · 1/1.15 · 1 · 1.15 · 1.15². Geometric because font size
 * is perceived multiplicatively — an additive step (+15 percentage points) would
 * be huge at the bottom and negligible at the top. 1.15 sits between the "major
 * second" (1.125) and "minor third" (1.2) of the classic modular scales: every
 * step is clearly visible without the text jumping. Two steps down (76%) stay
 * readable, two steps up (132%) are noticeably larger.
 *
 * `percent` is precomputed so the UI can show "115%" without doing the math
 * itself (0.76 * 100 = 76.00000000000001 in float arithmetic).
 */
export const READING_FONT_SCALES = [
  { value: 0.76, percent: 76 },
  { value: 0.87, percent: 87 },
  { value: 1, percent: 100 },
  { value: 1.15, percent: 115 },
  { value: 1.32, percent: 132 },
]

export const READING_FONT_SCALE_VALUES = READING_FONT_SCALES.map(step => step.value)

export const DEFAULT_READING_FONT_SCALE = 1
export const MIN_READING_FONT_SCALE = READING_FONT_SCALE_VALUES[0]
export const MAX_READING_FONT_SCALE = READING_FONT_SCALE_VALUES[READING_FONT_SCALE_VALUES.length - 1]

/**
 * Two legacy formats sit in persistence and both need to be mapped onto the
 * current ladder:
 *
 * 1. **px** (the very first version): [15, 16, 17, 19, 21, 24] with 17 as
 *    "normal". Detected purely numerically — a factor is never > 3, a px size
 *    is never < 3. Dividing by LEGACY_PX_BASE turns it into a factor.
 * 2. **old relative ladder** [0.85, 1, 1.15, 1.3, 1.5]: already a factor, so no
 *    conversion is needed, just snapping to the nearest new step.
 *
 * After that the same path handles both: clamp, then snap to the nearest step.
 * No version marker is needed in persistence.
 */
const LEGACY_PX_BASE = 17
const LEGACY_PX_THRESHOLD = 3

/**
 * Reading width in `ch`, not px: typographically what matters is line length in
 * *characters*, and `ch` automatically scales with the chosen font and font size
 * — a fixed px width would simply be wrong for a font that runs very narrow.
 *
 * The established rule of thumb for body text is 45–75 characters per line, with
 * ~66 as the ideal (Bringhurst). All three steps sit inside this band, evenly
 * spaced 10 ch apart:
 *
 * - `narrow` 55ch — lower half of the band: a calm, narrow column, good on small
 *   displays and with large fonts; below ~45 ch line breaks would get choppy.
 * - `normal` 65ch — the rule's ideal value (and exactly what Tailwind's
 *   `max-w-prose` uses). Default.
 * - `wide`  75ch — the upper bound of the rule: more text per line for large
 *   displays; beyond that the eye loses the line on the return sweep.
 *
 * (`ch` is the width of "0" and thus usually somewhat narrower than the average
 * character in body text — so 65ch lands close to the ~66-character ideal in
 * practice.)
 */
export const READING_WIDTHS = [
  { id: 'narrow', ch: 55, value: '55ch' },
  { id: 'normal', ch: 65, value: '65ch' },
  { id: 'wide', ch: 75, value: '75ch' },
]

export const READING_WIDTH_IDS = READING_WIDTHS.map(width => width.id)

export const DEFAULT_READING_WIDTH = 'normal'

export function getReadingFont(fontId) {
  return READING_FONTS.find(font => font.id === fontId) || READING_FONTS[0]
}

/** CSS `font-family` for the id; unknown ids fall back to System. */
export function resolveFontStack(fontId) {
  return getReadingFont(fontId).stack
}

/** The font's compensation factor (Playwrite is small-bodied, OpenDyslexic runs large). */
export function getFontSizeFactor(fontId) {
  return getReadingFont(fontId).sizeFactor || 1
}

/** Only the `@font-face` rules of the selected font. System returns ''. */
export function buildFontFaceCss(fontId) {
  return getReadingFont(fontId).faces
}

/**
 * All `@font-face` rules at once — exclusively for picker UIs that render each
 * entry in its own font. The reading view still only gets
 * `buildFontFaceCss(selectedFont)`, so the iframe doesn't load seven files to
 * display one.
 */
export function buildAllFontFaceCss() {
  return READING_FONTS.map(font => font.faces)
    .filter(Boolean)
    .join('\n')
}

export const READING_FONTS_STYLE_ID = 'quell-reading-fonts'

/**
 * Appends the `@font-face` rules of *all* reading fonts as a `<style>` into a
 * document (the app document by default), so e.g. the font picker can show each
 * row in its own font.
 *
 * Idempotent: a second call finds the existing tag and inserts nothing twice.
 * No network — the woff2 files are bundled and same-origin.
 */
export function injectReadingFonts(doc = typeof document === 'undefined' ? null : document) {
  const head = doc?.head
  if (!head) return null

  const existing =
    doc.getElementById?.(READING_FONTS_STYLE_ID) || head.querySelector(`#${READING_FONTS_STYLE_ID}`)
  if (existing) return existing

  const style = doc.createElement('style')
  style.id = READING_FONTS_STYLE_ID
  style.textContent = buildAllFontFaceCss()
  head.appendChild(style)
  return style
}

/**
 * Normalizes a stored value onto a step from READING_FONT_SCALES.
 *
 * - Legacy px values (> 3) are converted into a factor via LEGACY_PX_BASE:
 *   15→0.87, 16→1, 17→1, 19→1.15, 21→1.32, 24→1.32.
 * - Values from the old relative ladder snap to the nearest new step:
 *   0.85→0.87, 1→1, 1.15→1.15, 1.3→1.32, 1.5→1.32.
 * - Everything else is clamped and likewise snapped to the nearest step.
 * - Garbage (null, 'abc', NaN, Infinity) falls back to the default.
 */
export function resolveFontScale(value) {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_READING_FONT_SCALE

  const scale = numeric > LEGACY_PX_THRESHOLD ? numeric / LEGACY_PX_BASE : numeric
  const clamped = Math.min(Math.max(scale, MIN_READING_FONT_SCALE), MAX_READING_FONT_SCALE)

  return READING_FONT_SCALE_VALUES.reduce(
    (best, step) => (Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best),
    READING_FONT_SCALE_VALUES[0],
  )
}

/**
 * Effective size as an `em` number: user factor × the font's `sizeFactor`.
 *
 * Deliberately relative instead of px: the reading view's body gets an `em`
 * from this, which resolves against the iframe document's (system) default
 * size. If the user increases their device's font size, the text grows with
 * it; every other size in the reading view is in turn relative to this body
 * value.
 */
export function resolveFontSizeEm(fontId, value) {
  const scale = resolveFontScale(value)
  const em = scale * getFontSizeFactor(fontId)
  return Math.round(em * 1000) / 1000
}

/**
 * Only for previews in the *app* document, where a px base is known. The
 * reading view does not use this — there `resolveFontSizeEm` applies.
 */
export function resolveFontSizePx(fontId, value, basePx = 16) {
  return Math.round(resolveFontSizeEm(fontId, value) * basePx)
}

/** Entry from READING_WIDTHS; unknown ids fall back to `normal`. */
export function getReadingWidth(widthId) {
  return (
    READING_WIDTHS.find(width => width.id === widthId) ||
    READING_WIDTHS.find(width => width.id === DEFAULT_READING_WIDTH)
  )
}

/** Normalized width id (`narrow` | `normal` | `wide`). */
export function resolveReadingWidth(widthId) {
  return getReadingWidth(widthId).id
}

/** CSS value of the width, e.g. `'65ch'` — for direct use in `--q-reading-width`. */
export function resolveReadingWidthValue(widthId) {
  return getReadingWidth(widthId).value
}

/**
 * Normalizes the stored reading prefs into safe values.
 *
 * `prefs.fontSize` is the persisted value — a factor going forward, with old px
 * values migrated. `fontSize` in the result is the normalized factor (alias
 * `fontScale`), `fontSizeEm` the em number derived from it, including
 * `sizeFactor`.
 *
 * `prefs.width` is the width id; the result carries `width` (the normalized id,
 * for the UI picker) and `widthValue` (the CSS value for `--q-reading-width`).
 */
export function resolveReadingPrefs(prefs = {}) {
  const font = getReadingFont(prefs?.font).id
  const fontScale = resolveFontScale(prefs?.fontSize ?? prefs?.fontScale)
  const width = getReadingWidth(prefs?.width)
  return {
    font,
    fontScale,
    fontSize: fontScale,
    fontSizeEm: resolveFontSizeEm(font, fontScale),
    sizeFactor: getFontSizeFactor(font),
    stack: resolveFontStack(font),
    faces: buildFontFaceCss(font),
    width: width.id,
    widthValue: width.value,
    widthCh: width.ch,
  }
}
