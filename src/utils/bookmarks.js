export function exportBookmarks(articles, options = {}) {
  // The folder name is what the reader sees after importing the file elsewhere —
  // 'Quell' for the reading list, 'Quell Archive' for the archive.
  const folder = String(options.folder || 'Quell')
  const entries = articles
    .map(a => {
      const addDate = toUnixSeconds(a.publishedAt)
      const attrs = addDate === null ? '' : ` ADD_DATE="${addDate}"`
      let entry = `        <DT><A HREF="${escHtml(a.url)}"${attrs}>${escHtml(a.title || a.url)}</A>`
      if (a.description) entry += `\n        <DD>${escHtml(a.description)}`
      return entry
    })
    .join('\n')

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${toUnixSeconds(new Date().toISOString())}">${escHtml(folder)}</H3>
    <DL><p>
${entries}
    </DL><p>
</DL><p>`
}

export function parseBookmarks(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  // Folders are just nested <DL>s — querySelectorAll flattens them for us.
  const links = doc.querySelectorAll('a[href]')

  return Array.from(links)
    .map(el => {
      // The raw attribute, not el.href — that would resolve relative URLs against the document base.
      const url = (el.getAttribute('href') || '').trim()
      if (!isHttpUrl(url)) return null
      return {
        url,
        title: el.textContent.trim() || url,
        description: readDescription(el),
        publishedAt: fromUnixSeconds(el.getAttribute('add_date')),
      }
    })
    .filter(Boolean)
}

// A <DD> description follows its <DT> as a sibling — the HTML parser auto-closes both.
function readDescription(el) {
  const dt = el.closest('dt')
  const next = dt && dt.nextElementSibling
  if (!next || next.tagName !== 'DD') return ''
  return next.textContent.trim()
}

function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function toUnixSeconds(isoString) {
  const ms = Date.parse(isoString)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function fromUnixSeconds(value) {
  const seconds = Number(value)
  if (!value || !Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
