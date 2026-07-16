export function exportOpml(feeds) {
  const outlines = feeds
    .map(f => `    <outline type="rss" text="${escXml(f.title)}" title="${escXml(f.title)}" xmlUrl="${escXml(f.url)}"/>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Quell Feeds</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>`
}

export function parseOpml(xmlString) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString, 'application/xml')
  const outlines = doc.querySelectorAll('outline[xmlUrl]')
  return Array.from(outlines).map(el => ({
    title: el.getAttribute('title') || el.getAttribute('text') || el.getAttribute('xmlUrl'),
    url: el.getAttribute('xmlUrl'),
  }))
}

function escXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
