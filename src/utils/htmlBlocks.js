/**
 * Top-level HTML blocks — the unit the streaming translation works in.
 *
 * An article's HTML is a flat sequence of block elements (<p>, <h2>, <figure>, …).
 * Splitting along those boundaries is what lets the translation (a) chunk requests
 * without ever cutting inside a tag and (b) swap paragraphs into the reading view
 * one by one while the model is still streaming the rest.
 */

/** Elements that never have a closing tag — they must not change the nesting depth. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Wrapper elements that carry structure, not meaning. Readability and site templates
 * love to hand over the WHOLE article inside one `<div class="page">` — split at that
 * level, "paragraph-wise" translation would dim and swap the entire article as a
 * single block (seen live with an Irish Times article: 1 block of 4789 characters).
 * Containers whose children are block-level get dissolved into those children.
 */
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main'])

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'figure',
  'blockquote', 'pre', 'hr', 'div', 'section', 'article', 'main',
])

function hasBlockChild(element) {
  for (const child of element.children) {
    if (BLOCK_TAGS.has(child.tagName.toLowerCase())) return true
  }
  return false
}

function collectBlocks(node, blocks) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.textContent.trim()
      if (text) blocks.push(text)
    } else if (child.nodeType === 1) {
      const tag = child.tagName.toLowerCase()
      if (CONTAINER_TAGS.has(tag) && hasBlockChild(child)) {
        // The wrapper itself is dropped (its attributes style nothing in the reading
        // view) — its children are the real blocks.
        collectBlocks(child, blocks)
      } else {
        blocks.push(child.outerHTML)
      }
    }
  }
}

/**
 * Splits HTML into its translatable blocks: top-level elements, with structural
 * wrappers dissolved (see CONTAINER_TAGS) and bare text kept as a block of its own.
 * The browser's parser does the heavy lifting, so the result is exactly what the
 * reading view will render.
 */
export function splitHtmlBlocks(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  const blocks = []
  collectBlocks(doc.body, blocks)
  return blocks
}

/**
 * Groups blocks into translation chunks of roughly `limit` characters, never
 * splitting a block. Returns `{start, count, html}` per chunk — start/count are
 * indices into the block list, which is what maps a streamed chunk back onto the
 * paragraphs it replaces. An oversized single block travels alone rather than cut:
 * a broken tag is worse than a long request.
 */
export function planTranslationChunks(blocks, limit) {
  const chunks = []
  let start = 0
  let count = 0
  let html = ''

  for (const block of blocks) {
    if (count > 0 && html.length + block.length > limit) {
      chunks.push({ start, count, html })
      start += count
      count = 0
      html = ''
    }
    html += block
    count += 1
  }
  if (count > 0) chunks.push({ start, count, html })

  return chunks
}

/**
 * Incremental scanner over a growing model answer: feed it the full text so far,
 * get back the top-level blocks that have COMPLETED since the last call.
 *
 * It never guesses about incomplete input — a block is only emitted once its
 * closing tag has fully arrived. A leading markdown fence (```html) is skipped,
 * comments and stray closing tags are consumed silently. The scanner is a display
 * optimization only: the authoritative result is the finished chunk, re-parsed by
 * the browser — so an imperfect scan can delay a preview but never corrupt one.
 *
 * @returns {{scan: (fullText: string) => string[]}}
 */
export function createHtmlBlockScanner() {
  let pos = 0
  let fenceChecked = false

  function scan(text) {
    const found = []

    if (!fenceChecked) {
      let i = pos
      while (i < text.length && /\s/.test(text[i])) i += 1
      if (i >= text.length) return found
      if (text.startsWith('```', i)) {
        const newline = text.indexOf('\n', i)
        if (newline === -1) return found // the fence line is still streaming in
        pos = newline + 1
      } else {
        pos = i
      }
      fenceChecked = true
    }

    for (;;) {
      while (pos < text.length && /\s/.test(text[pos])) pos += 1
      if (pos >= text.length) break

      if (text[pos] !== '<') {
        // Top-level text runs until the next tag begins. Without a following '<' it
        // may still be growing — wait.
        const lt = text.indexOf('<', pos)
        if (lt === -1) break
        const piece = text.slice(pos, lt).trim()
        // A closing ``` fence is stream decoration, not article text.
        if (piece && !/^`{3,}\s*$/.test(piece)) found.push(piece)
        pos = lt
        continue
      }

      const element = readElement(text, pos)
      if (!element) break // incomplete — wait for more stream
      if (element.emit) found.push(text.slice(pos, element.end))
      pos = element.end
    }

    return found
  }

  return { scan }
}

/**
 * Reads one top-level node starting at `start` (which points at '<').
 * @returns {{end: number, emit: boolean}|null} null while the node is incomplete
 */
function readElement(text, start) {
  if (text.startsWith('<!--', start)) {
    const end = text.indexOf('-->', start)
    return end === -1 ? null : { end: end + 3, emit: false }
  }
  if (text.startsWith('<!', start)) {
    const gt = findTagEnd(text, start)
    return gt === -1 ? null : { end: gt + 1, emit: false }
  }

  let depth = 0
  let i = start

  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) return null

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt)
      if (end === -1) return null
      i = end + 3
      continue
    }

    const gt = findTagEnd(text, lt)
    if (gt === -1) return null

    const raw = text.slice(lt, gt + 1)
    const name = (raw.match(/^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/) || [])[1]?.toLowerCase()
    if (!name) {
      i = gt + 1 // "<3 points" and similar non-tags — the browser skips them too
      continue
    }

    if (raw[1] === '/') {
      if (depth === 0) return { end: gt + 1, emit: false } // stray closer — swallow
      depth -= 1
      if (depth === 0) return { end: gt + 1, emit: true }
    } else if (!VOID_TAGS.has(name) && !raw.endsWith('/>')) {
      depth += 1
    } else if (depth === 0) {
      return { end: gt + 1, emit: true } // a lone <img>/<hr> is a complete block
    }

    i = gt + 1
  }

  return null
}

/** The matching '>', ignoring any '>' inside quoted attribute values. */
function findTagEnd(text, start) {
  let quote = null
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  return -1
}
