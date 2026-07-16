// Turns the sanitized article HTML that fetchArticleContent() (articleParser.js)
// hands back into plain text.
//
// Two consumers, two shapes:
//   • extractArticleText()     — marker-free prose, for the TTS engine and for
//     "copy as plain text" (paste into a read-aloud app, a mail, a chat).
//   • extractArticleMarkdown() — the same content with its structure intact, for
//     "copy the whole article" (paste into notes, Obsidian, a ticket).
//
// ── Why alt texts can never leak into the read-aloud text ────────────────────
// Text is collected from DOM *text nodes* only (nodeType 3) and never from
// attributes. `alt`, `title` and `aria-label` live in attributes, and both
// `textContent` and our own walker ignore attributes by construction — so an
// image's alt text cannot end up in the spoken text even when the image itself
// is kept. extractArticleMarkdown() is the one place that reads `alt`, on
// purpose, because `![alt](src)` is what a notes app wants.

/** Android's TextToSpeech.getMaxSpeechInputLength() is 4000 characters on every
 *  common engine, and the plugin passes our string straight to it (see
 *  android/.../TextToSpeech.java: `tts.speak(text, …)` — no chunking anywhere).
 *  Anything longer is silently dropped, so we must split before we speak.
 *  3500 leaves headroom for OEM engines that report less than 4000. */
export const MAX_UTTERANCE_CHARS = 3500

// Elements that carry no readable prose. Scripts and styles are already gone by
// the time sanitize.js is done, but extractArticleText() is a public helper and
// may be handed raw HTML by a caller or a test — so it defends itself.
const DROP_TAGS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas',
  'iframe', 'object', 'embed', 'video', 'audio',
  'form', 'input', 'select', 'textarea', 'button',
]

// Blocks get a blank line between them, which is what makes the engine pause
// instead of slurring one paragraph into the next.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TR', 'UL',
])

// Class/itemprop hints for captions that are not wrapped in <figcaption>.
// Deliberately narrow: a bare "credit" would also match a legitimate paragraph.
const CAPTION_HINTS = [
  'caption',           // covers .caption, .wp-caption-text, .image-caption, …
  'bildunterschrift',
  'image-credit', 'imagecredit', 'photo-credit', 'media-credit',
]

// The same list as DROP_TAGS, plus the media elements that prepareRoot() removes
// separately — as a Set of tag names, for the non-destructive walker below.
const DROP_ELEMENTS = new Set([
  ...DROP_TAGS.map(tag => tag.toUpperCase()),
  'IMG', 'PICTURE', 'SOURCE',
])

function parseBody(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  return doc.body
}

function hasCaptionHint(element) {
  const classes = element.getAttribute('class') || ''
  const itemprop = element.getAttribute('itemprop') || ''
  const haystack = `${classes} ${itemprop}`.toLowerCase()
  return CAPTION_HINTS.some(hint => haystack.includes(hint))
}

/**
 * Strips everything the caller does not want to see, so that the serializers
 * below can stay dumb.
 */
function prepareRoot(html, { skipCaptions, skipImages }) {
  const root = parseBody(html)

  root.querySelectorAll(DROP_TAGS.join(',')).forEach(el => el.remove())

  // A <figure> built around an image contains, by definition, the image and its
  // caption and nothing else — so when the caller wants neither, the whole
  // figure goes. This catches captions that hide in a <p> or a .caption <div>
  // inside the figure, not just in <figcaption>. Must run BEFORE the images are
  // removed, or we can no longer tell an image figure from a code figure.
  if (skipCaptions && skipImages) {
    root.querySelectorAll('figure').forEach(figure => {
      if (figure.querySelector('img, picture')) figure.remove()
    })
  }

  if (skipCaptions) {
    root.querySelectorAll('figcaption').forEach(el => el.remove())
    Array.from(root.querySelectorAll('*'))
      .filter(el => hasCaptionHint(el))
      .forEach(el => el.remove())
  }

  if (skipImages) {
    root.querySelectorAll('img, picture, source').forEach(el => el.remove())
  }

  return root
}

/**
 * Plain prose. Blocks are separated by a blank line; that double newline is the
 * pause the TTS engine needs between paragraphs and after headings.
 *
 * @param {string} html sanitized article HTML
 * @param {{skipCaptions?: boolean}} [options] `skipCaptions` (default true) drops
 *   <figcaption>, caption-ish elements and image figures. Images are always
 *   dropped here — an image has no text, and its `alt` is an attribute, which is
 *   never read (see the note at the top of this file).
 * @returns {string} '' for empty or text-free HTML
 */
export function extractArticleText(html, options = {}) {
  const skipCaptions = options.skipCaptions !== false
  const root = prepareRoot(html, { skipCaptions, skipImages: true })

  const blocks = []
  let buffer = []

  const flush = () => {
    const line = buffer.join('').replace(/\s+/g, ' ').trim()
    if (line) blocks.push(line)
    buffer = []
  }

  const walk = node => {
    for (const child of node.childNodes) {
      // Text nodes only — attributes (alt, title, aria-label) are never touched.
      if (child.nodeType === 3) {
        buffer.push(child.nodeValue)
        continue
      }
      if (child.nodeType !== 1) continue

      // A <br> is a line break in the prose; give it a pause of its own rather
      // than collapsing it into a space.
      if (child.tagName === 'BR') {
        flush()
        continue
      }

      if (BLOCK_TAGS.has(child.tagName)) {
        flush()
        walk(child)
        flush()
        continue
      }

      walk(child)
    }
  }

  walk(root)
  flush()

  return blocks.join('\n\n')
}

// ── Speech blocks ───────────────────────────────────────────────────────────

/**
 * The same skip rules as prepareRoot(), as a *predicate*: collectSpeechBlocks()
 * walks a live document that is on screen, so it must not remove anything from it.
 */
function skipsForSpeech(element, skipCaptions) {
  if (DROP_ELEMENTS.has(element.tagName)) return true
  if (!skipCaptions) return false
  if (element.tagName === 'FIGCAPTION') return true
  // An image figure is the image plus its caption and nothing else — see prepareRoot().
  if (element.tagName === 'FIGURE' && element.querySelector('img, picture')) return true
  return hasCaptionHint(element)
}

/**
 * The read-aloud units of an article, one per block element, in reading order —
 * with the element each one came from.
 *
 * Takes an **Element**, not an HTML string, because the caller is the reading view
 * and it needs the nodes of the very document it is showing: to highlight the
 * paragraph being spoken, and to start reading at the paragraph the reader tapped.
 * A detached re-parse of the same HTML would give equal text and useless nodes.
 *
 * Images and captions are skipped exactly as in extractArticleText(), and text is
 * still read from text nodes only, so no `alt` can leak in (see the top of this file).
 *
 * @param {Element} root the article body of the live document
 * @param {{skipCaptions?: boolean}} [options]
 * @returns {Array<{element: Element|null, text: string}>} `element` is null only for
 *   loose text that sits in no block at all
 */
export function collectSpeechBlocks(root, options = {}) {
  if (!root) return []
  const skipCaptions = options.skipCaptions !== false

  const blocks = []
  let buffer = []
  let owner = null

  const flush = () => {
    const text = buffer
      .join('')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n+ ?/g, '\n')
      .trim()
    buffer = []
    if (text) blocks.push({ element: owner, text })
  }

  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        buffer.push(child.nodeValue)
        continue
      }
      if (child.nodeType !== 1) continue
      if (skipsForSpeech(child, skipCaptions)) continue

      // A <br> stays *inside* its block: one paragraph must remain one unit, or it
      // would be highlighted, counted and tapped as two. The newline survives into
      // the spoken text, so the engine still pauses at it.
      if (child.tagName === 'BR') {
        buffer.push('\n')
        continue
      }

      if (BLOCK_TAGS.has(child.tagName)) {
        flush()
        const parent = owner
        owner = child
        walk(child)
        flush()
        owner = parent
        continue
      }

      walk(child)
    }
  }

  walk(root)
  flush()

  return blocks
}

// ── Markdown ────────────────────────────────────────────────────────────────
// Prose is not escaped. A copy button exists to produce something a human pastes
// and reads; peppering the text with backslashes to defend against a stray `*`
// costs more than the rare mis-rendered emphasis it prevents.

function inline(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ')
  if (node.nodeType !== 1) return ''

  const children = () => Array.from(node.childNodes).map(inline).join('')

  switch (node.tagName) {
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B': {
      const text = children().trim()
      return text ? `**${text}**` : ''
    }
    case 'EM':
    case 'I': {
      const text = children().trim()
      return text ? `*${text}*` : ''
    }
    case 'CODE': {
      const text = children().trim()
      return text ? `\`${text}\`` : ''
    }
    case 'A': {
      const text = children().trim()
      const href = node.getAttribute('href') || ''
      if (!text) return ''
      return href ? `[${text}](${href})` : text
    }
    case 'IMG': {
      const src = node.getAttribute('src') || ''
      const alt = (node.getAttribute('alt') || '').trim()
      return src ? `![${alt}](${src})` : ''
    }
    default:
      return children()
  }
}

function inlineOf(node) {
  return Array.from(node.childNodes).map(inline).join('').replace(/[ \t]+/g, ' ').trim()
}

function renderList(list, depth) {
  const ordered = list.tagName === 'OL'
  const indent = '  '.repeat(depth)
  const items = []

  Array.from(list.children)
    .filter(child => child.tagName === 'LI')
    .forEach((item, position) => {
      const nested = Array.from(item.children).filter(el => el.tagName === 'UL' || el.tagName === 'OL')
      const clone = item.cloneNode(true)
      Array.from(clone.children)
        .filter(el => el.tagName === 'UL' || el.tagName === 'OL')
        .forEach(el => el.remove())

      const marker = ordered ? `${position + 1}.` : '-'
      const text = inlineOf(clone)
      const lines = [`${indent}${marker} ${text}`.trimEnd()]
      nested.forEach(sub => lines.push(renderList(sub, depth + 1)))
      items.push(lines.filter(Boolean).join('\n'))
    })

  return items.join('\n')
}

function renderBlock(element) {
  const tag = element.tagName

  if (/^H[1-6]$/.test(tag)) {
    const text = inlineOf(element)
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : ''
  }

  switch (tag) {
    case 'P':
      return inlineOf(element)

    case 'UL':
    case 'OL':
      return renderList(element, 0)

    case 'BLOCKQUOTE':
      return inlineOf(element)
        .split('\n')
        .map(line => `> ${line}`.trimEnd())
        .join('\n')

    case 'PRE': {
      const code = (element.textContent || '').replace(/\n+$/, '')
      return code ? `\`\`\`\n${code}\n\`\`\`` : ''
    }

    case 'HR':
      return '---'

    case 'FIGCAPTION': {
      const text = inlineOf(element)
      return text ? `*${text}*` : ''
    }

    case 'IMG':
      return inline(element)

    case 'TABLE': {
      const rows = Array.from(element.querySelectorAll('tr'))
        .map(row => Array.from(row.children).map(cell => inlineOf(cell)))
        .filter(cells => cells.length > 0)
      if (rows.length === 0) return ''

      const lines = [`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`]
      rows.slice(1).forEach(cells => lines.push(`| ${cells.join(' | ')} |`))
      return lines.join('\n')
    }

    default:
      return null // not a leaf we know — the caller recurses into it
  }
}

function renderChildren(node) {
  const blocks = []
  let buffer = []

  const flushInline = () => {
    const text = buffer.join('').replace(/[ \t]+/g, ' ').trim()
    if (text) blocks.push(text)
    buffer = []
  }

  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      buffer.push(child.nodeValue)
      continue
    }
    if (child.nodeType !== 1) continue

    const rendered = renderBlock(child)
    if (rendered !== null) {
      flushInline()
      if (rendered) blocks.push(rendered)
      continue
    }

    // FIGURE, DIV, SECTION, … — a container, not a leaf.
    if (BLOCK_TAGS.has(child.tagName) || child.tagName === 'FIGURE') {
      flushInline()
      const nested = renderChildren(child)
      if (nested) blocks.push(nested)
      continue
    }

    buffer.push(inline(child))
  }

  flushInline()
  return blocks.join('\n\n')
}

/**
 * The article as Markdown — the "rich" variant behind the copy button.
 *
 * Markdown, not structured plain text, because the paste targets that matter
 * (notes apps, Obsidian, issue trackers, chats) either render it or show it as
 * readable plain text anyway — while structured plain text has nowhere to put a
 * link and would have to drop hrefs or inline them as bare URLs, which reads
 * worse in *both* worlds. For the "paste into a read-aloud app" case the caller
 * should use extractArticleText(): that is exactly the marker-free variant, so
 * the two exports cover the two paste targets instead of compromising on one.
 *
 * @param {string} html sanitized article HTML
 * @param {{skipCaptions?: boolean, skipImages?: boolean}} [options] both default
 *   to true. `{skipCaptions: false, skipImages: false}` is the "copy everything"
 *   mode: images become `![alt](src)`, captions become an italic line.
 * @returns {string}
 */
export function extractArticleMarkdown(html, options = {}) {
  const skipCaptions = options.skipCaptions !== false
  const skipImages = options.skipImages !== false
  const root = prepareRoot(html, { skipCaptions, skipImages })
  return renderChildren(root).replace(/\n{3,}/g, '\n\n').trim()
}

// ── Utterances ──────────────────────────────────────────────────────────────

/**
 * Sentence boundaries: terminal punctuation, optional closing quote/bracket, then
 * whitespace. No lookbehind — Safari only learned it in 16.4 and Capacitor still
 * ships to older WKWebViews.
 *
 * Over-eager splits (after "z. B.", "Dr.", "usw.") are harmless by construction:
 * the pieces are greedily re-packed up to the limit right afterwards, so an
 * abbreviation almost always lands back in the same utterance as its sentence.
 */
function splitSentences(text) {
  const sentences = []
  const boundary = /[.!?…]+["'”’)\]]*\s+/g
  let start = 0
  let match

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length
    const sentence = text.slice(start, end).trim()
    if (sentence) sentences.push(sentence)
    start = end
  }

  const tail = text.slice(start).trim()
  if (tail) sentences.push(tail)
  return sentences
}

/**
 * Last resort for a single sentence that is longer than the whole limit. Cuts on
 * spaces so no word is ever torn in half, and always makes progress — a URL of
 * 5000 characters with no space in it gets cut hard rather than looping forever.
 */
function splitLongSegment(segment, limit) {
  const pieces = []
  let rest = segment

  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit)
    if (cut <= 0) cut = limit // one unbroken word longer than the limit
    const piece = rest.slice(0, cut).trim()
    if (piece) pieces.push(piece)
    rest = rest.slice(cut).trim()
  }

  if (rest) pieces.push(rest)
  return pieces
}

/**
 * Splits read-aloud text into chunks the engine will actually speak in full.
 *
 * Paragraphs stay whole wherever they fit and are packed together with their
 * blank line intact, so the engine keeps pausing between them. Only a paragraph
 * that is longer than the limit is broken up, and then on sentence boundaries.
 *
 * @param {string} text output of extractArticleText()
 * @param {number} [maxChars=MAX_UTTERANCE_CHARS]
 * @returns {string[]} [] for empty input; every entry is <= maxChars
 */
export function splitIntoUtterances(text, maxChars = MAX_UTTERANCE_CHARS) {
  const source = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []

  const limit = Math.max(1, Math.floor(Number(maxChars) || MAX_UTTERANCE_CHARS))

  const segments = []
  for (const paragraph of source.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)) {
    if (paragraph.length <= limit) {
      segments.push(paragraph)
      continue
    }

    let current = ''
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length > limit) {
        if (current) segments.push(current)
        current = ''
        segments.push(...splitLongSegment(sentence, limit))
        continue
      }

      const candidate = current ? `${current} ${sentence}` : sentence
      if (candidate.length > limit) {
        if (current) segments.push(current)
        current = sentence
      } else {
        current = candidate
      }
    }
    if (current) segments.push(current)
  }

  const utterances = []
  let current = ''

  for (const segment of segments) {
    const candidate = current ? `${current}\n\n${segment}` : segment
    if (candidate.length > limit) {
      if (current) utterances.push(current)
      current = segment
    } else {
      current = candidate
    }
  }
  if (current) utterances.push(current)

  return utterances
}
