import DOMPurify from 'dompurify'

/**
 * The single definition of what may appear in the reading view.
 *
 * Two very different sources end up here and both are untrusted: the HTML fetched
 * from the publisher, and the HTML an LLM hands back from a translation. Neither
 * gets to define its own rules.
 */
export const ALLOWED_TAGS = [
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'strong', 'em', 'b', 'i',
  'img', 'picture', 'source', 'figure', 'figcaption', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span',
  'hr', 'sub', 'sup',
]

export const ALLOWED_ATTR = [
  'src', 'srcset', 'data-src', 'data-srcset', 'data-original', 'data-original-src',
  'href', 'alt', 'title', 'class', 'loading', 'width', 'height', 'sizes',
  'decoding', 'fetchpriority', 'style',
]

export function sanitizeArticleHtml(html) {
  return DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
  })
}
