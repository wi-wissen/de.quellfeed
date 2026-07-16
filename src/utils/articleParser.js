import { Readability } from '@mozilla/readability'
import { httpGet } from './http.js'
import { getDomainConfig } from './domainConfig.js'
import { buildReadingThemeCss } from './theme.js'
import { sanitizeArticleHtml } from './sanitize.js'
import { rememberDeclaredIcon } from './favicon.js'
import { normalizeLanguageTag } from './language.js'

const MIN_EXTRACTED_TEXT_LENGTH = 100
export const FEED_FALLBACK_MARKER_CLASS = 'feed-fallback-card'

const READING_CSS = `
  body {
    /* ch, not px: reading width is a line length in characters and therefore
       scales automatically with the chosen font and font size. */
    max-width: var(--q-reading-width, 65ch);
    margin: 0 auto;
    padding: 1rem 1.25rem;
    font-family: var(--q-reading-font, -apple-system, BlinkMacSystemFont, sans-serif);
    line-height: 1.7;
    color: var(--q-text, #1a1a1a);
    background: var(--q-bg, #ffffff);
    /* em, not px: reading size is a factor on the system font size. */
    font-size: var(--q-reading-font-size, 1em);
  }
  img { max-width: 100%; border-radius: 8px; height: auto; display: block; }
  .article-title {
    margin: 0 0 1.25rem;
    /* em, not rem: the title must follow the body's chosen font size. */
    font-size: clamp(1.9em, 1.55em + 1vw, 2.7em);
    line-height: 1.15;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .article-hero { margin: 0 0 1.5rem; }
  .article-hero img {
    width: 100%;
    border-radius: 14px;
    max-height: 320px;
    object-fit: cover;
    box-shadow: 0 18px 42px rgba(15, 23, 42, 0.18);
  }
  figcaption { font-size: 0.85em; color: var(--q-text-muted, #6b7280); text-align: center; margin-top: 0.4rem; }
  blockquote { border-left: 3px solid var(--q-accent, #1d3d8f); margin: 1.2rem 0; padding: 0.4rem 1rem; color: var(--q-text-muted, #6b7280); }
  pre, code { font-family: ui-monospace, monospace; background: var(--q-surface, #f3f4f6); border-radius: 4px; }
  pre { padding: 1rem; overflow-x: auto; }
  code { padding: 0.1em 0.3em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid var(--q-border, #e5e7eb); padding: 0.5rem; }
  a { color: var(--q-accent, #1d3d8f); }
  *[style*="position:fixed"], *[style*="position: fixed"],
  *[style*="position:sticky"], *[style*="position: sticky"] { position: static !important; }
  /* Streaming translation: paragraphs still waiting for their translation are dimmed;
     the ones already swapped in (.q-tx-fresh) read at full strength. Opacity sits on
     the CHILDREN, not the container — a child cannot out-opacity its parent. */
  .q-tx-rest > * { opacity: 0.45; }
  .q-tx-rest > .q-tx-fresh { opacity: 1; }
`

/**
 * Builds the reading view's complete `srcdoc` document.
 *
 * `options.reading` = `{ font, fontSize, width }` (all optional, see fonts.js).
 * `fontSize` is a *relative* factor (1 = 100%), not a px value; old px values
 * from persistence are migrated in fonts.js. `width` is a width id
 * (`narrow` | `normal` | `wide`) and is resolved into a `ch` value.
 *
 * On the CSP: `font-src 'self' data:` allows only our bundled fonts
 * (same-origin or inline, respectively). The original page's webfonts stay
 * blocked — that was the original intent of `font-src none`, which would,
 * however, also have blocked our own fonts. `script-src none` stays.
 */
export function buildIframeDoc(html, headerImageUrl = null, themeChoice = 'system', options = {}) {
  const articleTitle = options.title ? String(options.title).trim() : ''
  // The cover from the feed is almost always ALSO part of the extracted article —
  // usually under a different CDN URL, so an exact string match misses it and the
  // reader saw the same photo twice. Hence the second check: if the article opens
  // with an image of its own, the cover on top would be a duplication either way;
  // the cover is only added when the top is imageless. A domain config can overrule
  // both directions via `presentation.showFeedImage` (true forces, false forbids).
  const articleAlreadyShowsImage =
    (headerImageUrl && html.includes(headerImageUrl)) || articleLeadsWithImage(html)
  const showFeedImage = options.showFeedImage
  const showArticleTitle = options.showArticleTitle === true && articleTitle
  const shouldShowHeaderImage = headerImageUrl && (
    showFeedImage === true ||
    (showFeedImage !== false && !articleAlreadyShowsImage)
  )
  const title = showArticleTitle
    ? `<h1 class="article-title">${escapeHtml(articleTitle)}</h1>`
    : ''
  const header = shouldShowHeaderImage
    ? `<figure class="article-hero"><img src="${headerImageUrl}" alt=""></figure>`
    : ''
  // The article text lives in its own container so the streaming translation can
  // address "top-level block n" without counting past the title and the hero image.
  return `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="${buildCsp()}">
    <style>${buildReadingThemeCss(themeChoice, options.reading)}${READING_CSS}</style>
  </head><body>${title}${header}<main class="article-body">${html}</main></body></html>`
}

// How much article text may precede an image for it to still count as "the article
// opens with an image". Text, not raw HTML characters — attributes and markup would
// make the budget depend on how noisy the site's markup is. 500 characters is a lead
// paragraph or two: covers get pushed below an intro line or a byline on many sites,
// while a photo that only appears mid-article does not stop the hero on top.
const LEAD_IMAGE_TEXT_BUDGET = 500

/** Does the article show an image of its own before any real amount of text? */
export function articleLeadsWithImage(html) {
  if (!html || !html.includes('<img')) return false

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  // 0x1 | 0x4 = SHOW_ELEMENT | SHOW_TEXT — numeric, because the iframe builder also
  // runs under test environments where the NodeFilter global is not a given.
  const walker = doc.createTreeWalker(doc.body, 0x1 | 0x4)

  let textSeen = 0
  let node
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1 && node.tagName === 'IMG') return true
    if (node.nodeType === 3) {
      textSeen += node.textContent.replace(/\s+/g, ' ').trim().length
      if (textSeen > LEAD_IMAGE_TEXT_BUDGET) return false
    }
  }
  return false
}

/**
 * The reading view is a `srcdoc` iframe, so its document URL is `about:srcdoc` — and
 * `'self'` cannot be resolved against that. A CSP of `font-src 'self'` therefore blocks
 * our OWN bundled fonts: the @font-face rule applies (the family changes) but the woff2
 * never loads, so the text silently falls back to the next font in the stack.
 *
 * Naming the origin explicitly fixes it while keeping the intent intact — the article's
 * own remote webfonts stay blocked, which is what `font-src` was here for.
 */
function buildCsp() {
  const origin = typeof window !== 'undefined' && window.location?.origin
  const fontSrc = origin && origin !== 'null' ? `${origin} data:` : `'self' data:`

  return `font-src ${fontSrc}; script-src none;`
}

export async function fetchArticleContent(url, configBaseUrl = '', options = {}) {
  const res = await httpGet(url)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)

  const domParser = new DOMParser()
  const doc = domParser.parseFromString(res.data, 'text/html')

  // The page just told us where its icon lives. Taking it now means the feed list never
  // has to fetch anything of its own to find one.
  rememberDeclaredIcon(url, doc)

  // Set base so relative URLs resolve correctly
  const base = doc.createElement('base')
  base.href = url
  doc.head.prepend(base)

  // Remove fixed/sticky elements before extraction
  doc.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style') || ''
    if (/position\s*:\s*(fixed|sticky)/i.test(s)) el.remove()
  })

  const domain = new URL(url).hostname.replace(/^www\./, '')
  const config = await getDomainConfig(domain, configBaseUrl, {
    forceRefresh: options.forceConfigRefresh,
  })

  let html = null
  let fallbackImages = collectFallbackImages(doc.querySelector('article') || doc.querySelector('main') || doc.body)

  if (config) {
    const extracted = extractWithConfig(doc, config)
    html = extracted?.html || null
    fallbackImages = extracted?.fallbackImages || []
  }

  if (!html) {
    html = extractWithReadability(doc, url)
  }

  if (!html) {
    html = extractFallback(doc)
  }

  html = normalizeExtractedHtml(html, fallbackImages)

  const normalizedHtml = normalizeExtractedHtml(sanitizeArticleHtml(html))
  const finalHtml = shouldUseFeedItemFallback(normalizedHtml, options.feedFallback)
    ? buildFeedItemFallbackHtml(options.feedFallback)
    : normalizedHtml

  return {
    config,
    html: finalHtml,
    // What the page itself claims to be written in (<html lang>, or the old-school
    // meta header). '' means "the page didn't say" — never guessed here.
    language: normalizeLanguageTag(
      doc.documentElement.getAttribute('lang')
      || doc.querySelector('meta[http-equiv="content-language" i]')?.getAttribute('content')
    ),
  }
}

export async function fetchArticleHtml(url, configBaseUrl = '', options = {}) {
  const result = await fetchArticleContent(url, configBaseUrl, options)
  return result.html
}

function extractWithConfig(doc, config) {
  for (const selector of config.selectors.container) {
    const container = doc.querySelector(selector)
    if (container) {
      for (const sel of config.selectors.remove || []) {
        container.querySelectorAll(sel).forEach(el => el.remove())
      }
      return {
        html: container.innerHTML,
        fallbackImages: collectFallbackImages(container),
      }
    }
  }
  return null
}

function extractWithReadability(doc, url) {
  try {
    const clone = doc.cloneNode(true)
    const reader = new Readability(clone)
    const article = reader.parse()
    return article?.content || null
  } catch {
    return null
  }
}

function extractFallback(doc) {
  const el = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('body')
  return el?.innerHTML || ''
}

function shouldUseFeedItemFallback(html, feedFallback) {
  if (!feedFallback) return false
  if (!hasFeedFallbackContent(feedFallback)) return false
  return getTextContentLength(html) < MIN_EXTRACTED_TEXT_LENGTH
}

function hasFeedFallbackContent(feedFallback) {
  return Boolean(
    String(feedFallback.title || '').trim() ||
    String(feedFallback.description || '').trim() ||
    String(feedFallback.url || '').trim()
  )
}

function getTextContentLength(html) {
  if (!html) return 0
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim().length
}

function buildFeedItemFallbackHtml(feedFallback) {
  const title = String(feedFallback?.title || '').trim()
  const description = String(feedFallback?.description || '').trim()
  const url = String(feedFallback?.url || '').trim()
  const paragraphs = description
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => `<p>${escapeHtml(part)}</p>`)
    .join('')

  return `
    <article class="${FEED_FALLBACK_MARKER_CLASS}">
      ${title ? `<h1 class="article-title">${escapeHtml(title)}</h1>` : ''}
      ${paragraphs || '<p></p>'}
      ${url ? `<p><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></p>` : ''}
    </article>
  `.trim()
}

function normalizeExtractedHtml(html, fallbackImages = []) {
  if (!html) return ''

  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const root = doc.body

  root.querySelectorAll('noscript').forEach(node => {
    const noscriptDoc = new DOMParser().parseFromString(`<body>${node.textContent || ''}</body>`, 'text/html')
    const replacement = noscriptDoc.body.firstElementChild
    if (replacement) {
      node.replaceWith(replacement)
    } else {
      node.remove()
    }
  })

  root.querySelectorAll('img, source').forEach(promoteLazyMedia)
  root.querySelectorAll('[style]').forEach(sanitizeInlineStyle)

  if (fallbackImages.length > 0 && root.querySelectorAll('img').length === 0) {
    const fragment = doc.createDocumentFragment()
    fallbackImages.forEach(imageHtml => {
      const imageDoc = new DOMParser().parseFromString(`<body>${imageHtml}</body>`, 'text/html')
      const element = imageDoc.body.firstElementChild
      if (element) fragment.appendChild(doc.importNode(element, true))
    })
    root.prepend(fragment)
  }

  return root.innerHTML
}

function collectFallbackImages(container) {
  return Array.from(container.querySelectorAll('figure, picture, img'))
    .map(el => el.outerHTML)
    .filter(Boolean)
    .slice(0, 4)
}

function promoteLazyMedia(element) {
  const sourceCandidates = ['src', 'data-src', 'data-original', 'data-original-src']
  const srcsetCandidates = ['srcset', 'data-srcset']

  const sourceValue = sourceCandidates.map(attr => element.getAttribute(attr)).find(Boolean)
  const srcsetValue = srcsetCandidates.map(attr => element.getAttribute(attr)).find(Boolean)

  if (sourceValue) element.setAttribute('src', sourceValue)
  if (srcsetValue) element.setAttribute('srcset', srcsetValue)
}

function sanitizeInlineStyle(element) {
  const style = element.getAttribute('style')
  if (!style) return

  const allowedProperties = new Set([
    'width',
    'height',
    'max-width',
    'max-height',
    'min-width',
    'min-height',
    'padding-bottom',
    'padding-top',
    'margin',
    'margin-top',
    'margin-bottom',
    'text-align',
    'aspect-ratio',
    'object-fit',
  ])

  const sanitized = style
    .split(';')
    .map(rule => rule.trim())
    .filter(Boolean)
    .map(rule => {
      const [property, ...valueParts] = rule.split(':')
      const normalizedProperty = property?.trim().toLowerCase()
      const value = valueParts.join(':').trim()
      if (!normalizedProperty || !value || !allowedProperties.has(normalizedProperty)) return null
      if (/expression|url\(|position|fixed|sticky/i.test(value)) return null
      return `${normalizedProperty}: ${value}`
    })
    .filter(Boolean)
    .join('; ')

  if (sanitized) {
    element.setAttribute('style', sanitized)
  } else {
    element.removeAttribute('style')
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
