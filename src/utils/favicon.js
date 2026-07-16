/**
 * The site's own favicon — fetched from the site itself, not from a favicon service.
 *
 * This used to point at Google's `s2/favicons`, which meant that merely scrolling the feed
 * list told Google which sites the user reads. For an app whose whole pitch is "no
 * backend, nothing leaves your device", that was the one place we quietly broke the
 * promise. `icons.duckduckgo.com` would be the same deal with a friendlier logo: still a
 * third party, still undocumented, still an unpublished rate limit.
 *
 * So: `https://<host>/favicon.ico`, straight from the host whose article we are reading
 * anyway. It needs no CORS — an `<img>` may load cross-origin; it just may not be read
 * back into a canvas, which we never do.
 *
 * Not every site keeps a /favicon.ico. `<link rel="icon">` is the authoritative answer, so
 * whenever we have a page's HTML in hand for other reasons, we remember what it declared.
 * Nothing is ever fetched just to find an icon.
 */

/** Icon URLs a page declared for itself, keyed by hostname. */
const declared = {}

const ICON_REL = /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i

/**
 * @param {string} pageUrl the page the HTML came from
 * @param {Document} doc its parsed document
 */
export function rememberDeclaredIcon(pageUrl, doc) {
  try {
    const { hostname } = new URL(pageUrl)
    const links = [...doc.querySelectorAll('link[rel]')].filter(link =>
      ICON_REL.test(link.getAttribute('rel') || '')
    )
    if (links.length === 0) return

    // Biggest wins — a 16px favicon blown up into a 72px thumbnail is a smear.
    const best = links.slice().sort((a, b) => declaredSize(b) - declaredSize(a))[0]
    const href = best.getAttribute('href')
    if (!href) return

    declared[hostname] = new URL(href, pageUrl).href
  } catch {
    // A malformed href is not worth failing an import over.
  }
}

function declaredSize(link) {
  const match = (link.getAttribute('sizes') || '').match(/(\d+)x\d+/i)
  return match ? Number(match[1]) : 0
}

/** @returns {string|null} a URL an `<img>` can load, or null if the input is not a URL */
export function getFaviconUrl(pageUrl) {
  try {
    const { protocol, hostname } = new URL(pageUrl)
    if (declared[hostname]) return declared[hostname]
    return `${protocol}//${hostname}/favicon.ico`
  } catch {
    return null
  }
}

/**
 * Last resort, only after the site's own icon has failed to load.
 *
 * DuckDuckGo, not Google: it answers a plain 404 for a site it has no icon for, where
 * Google hands back a generic globe that looks like a real icon and is worse than nothing.
 * It is still an undocumented third-party endpoint with no stated rate limit, which is
 * exactly why it is the fallback and not the first stop — it only ever sees the handful of
 * hosts that keep no favicon of their own.
 *
 * @returns {string|null}
 */
export function getFaviconFallbackUrl(pageUrl) {
  try {
    const { hostname } = new URL(pageUrl)
    return `https://icons.duckduckgo.com/ip3/${hostname}.ico`
  } catch {
    return null
  }
}

/** Test seam. */
export function resetDeclaredIcons() {
  for (const key of Object.keys(declared)) delete declared[key]
}
