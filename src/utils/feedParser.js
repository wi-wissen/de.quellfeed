import { httpGet } from './http.js'
import { normalizeLanguageTag } from './language.js'

export async function fetchAndParseFeed(url) {
  const res = await httpGet(url)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  return parseFeedString(res.data)
}

export function parseFeedString(xmlString) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlString.trim(), 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Feed XML parse error')

  if (doc.getElementsByTagName('channel').length > 0) return parseRss(doc)
  if (doc.getElementsByTagName('feed').length > 0) return parseAtom(doc)
  throw new Error('Unknown feed format')
}

function parseRss(doc) {
  const channel = doc.getElementsByTagName('channel')[0]
  return {
    title: normalizeFeedText(xmlText(channel, 'title')),
    // RSS declares the channel language (<language>de-de</language>). It decides
    // whether the reading view advertises the translate button for this feed's
    // articles when the page itself stays silent about its language.
    language: normalizeLanguageTag(xmlText(channel, 'language') || xmlText(channel, 'dc:language')),
    items: Array.from(doc.getElementsByTagName('item')).map(parseRssItem),
  }
}

function parseRssItem(item) {
  const mediaContent = item.getElementsByTagName('media:content')[0]
  const mediaThumbnail = item.getElementsByTagName('media:thumbnail')[0]
  const enclosure = item.getElementsByTagName('enclosure')[0]

  return {
    link: xmlText(item, 'link') || xmlText(item, 'guid'),
    guid: xmlText(item, 'guid'),
    title: normalizeFeedText(xmlText(item, 'title')),
    contentSnippet: normalizeFeedSnippet(xmlText(item, 'description')).slice(0, 280),
    'content:encoded': xmlText(item, 'content:encoded', 'encoded'),
    pubDate: xmlText(item, 'pubDate', 'dc:date'),
    mediaContent: mediaContent ? { $: { url: mediaContent.getAttribute('url') } } : null,
    mediaThumbnail: mediaThumbnail ? { $: { url: mediaThumbnail.getAttribute('url') } } : null,
    enclosure: enclosure
      ? { url: enclosure.getAttribute('url'), type: enclosure.getAttribute('type') || '' }
      : null,
  }
}

function parseAtom(doc) {
  const feed = doc.getElementsByTagName('feed')[0]
  return {
    title: normalizeFeedText(xmlText(feed, 'title')),
    // Atom carries the language as xml:lang on the root element.
    language: normalizeLanguageTag(feed.getAttribute('xml:lang')),
    items: Array.from(doc.getElementsByTagName('entry')).map(parseAtomEntry),
  }
}

function parseAtomEntry(entry) {
  const links = Array.from(entry.getElementsByTagName('link'))
  let link = ''
  for (const l of links) {
    const rel = l.getAttribute('rel') || 'alternate'
    if (rel === 'alternate') { link = l.getAttribute('href') || ''; break }
  }
  if (!link && links.length > 0) link = links[0].getAttribute('href') || ''

  const id = xmlText(entry, 'id')
  const summary = xmlText(entry, 'summary')
  const content = xmlText(entry, 'content')

  return {
    link: link || id,
    guid: id,
    title: normalizeFeedText(xmlText(entry, 'title')),
    contentSnippet: normalizeFeedSnippet(summary || content).slice(0, 280),
    'content:encoded': content,
    pubDate: xmlText(entry, 'published') || xmlText(entry, 'updated'),
    mediaContent: null,
    mediaThumbnail: null,
    enclosure: null,
  }
}

function xmlText(parent, ...tags) {
  for (const tag of tags) {
    const el = parent.getElementsByTagName(tag)[0]
    if (el) return el.textContent.trim()
  }
  return ''
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function normalizeFeedText(text) {
  if (!text) return ''
  if (!text.includes('&')) return text.trim()

  const doc = new DOMParser().parseFromString(`<textarea>${text}</textarea>`, 'text/html')
  return (doc.querySelector('textarea')?.value || text).trim()
}

function normalizeFeedSnippet(text) {
  return normalizeFeedText(stripHtml(normalizeFeedText(text)))
}

export function extractImage(item) {
  if (item.mediaContent?.$?.url) return item.mediaContent.$.url
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/')) return item.enclosure.url
  const html = item['content:encoded'] || item.content || ''
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/)
  return m ? m[1] : null
}

export function normalizeArticle(item, feedId) {
  return {
    id: crypto.randomUUID(),
    feedId,
    url: item.link || item.guid || '',
    title: normalizeFeedText(item.title || ''),
    description: normalizeFeedText(item.contentSnippet || ''),
    image: extractImage(item),
    isRead: false,
    isSaved: false,
    publishedAt: item.pubDate
      ? new Date(item.pubDate).toISOString()
      : new Date().toISOString(),
    cachedHtml: null,
  }
}

const COMMON_FEED_PATHS = ['/feed', '/feed/', '/rss', '/rss/', '/atom.xml', '/feed.xml', '/rss.xml', '/index.xml']

/**
 * Finds every feed a URL leads to. Returns [{ url, title }], newest-first is not
 * meaningful here — order follows the page, and the caller lets the user pick when
 * there is more than one. Sites like spektrum.de advertise a dozen feeds and the
 * first one in the HTML is rarely the one you want.
 */
export async function discoverFeeds(inputUrl) {
  const url = /^https?:\/\//.test(inputUrl) ? inputUrl : `https://${inputUrl}`

  try {
    const res = await httpGet(url)
    if (res.status === 200) {
      if (isFeedContent(res.data)) {
        return [{ url, title: readFeedTitle(res.data) || hostnameOf(url) }]
      }
      const linked = extractFeedLinks(res.data, url)
      if (linked.length > 0) return linked
    }
  } catch (e) {
    console.warn('[discoverFeeds] Initial fetch failed:', e.message)
  }

  const base = new URL(url).origin
  for (const path of COMMON_FEED_PATHS) {
    const candidate = base + path
    try {
      const res = await httpGet(candidate)
      if (res.status === 200 && isFeedContent(res.data)) {
        return [{ url: candidate, title: readFeedTitle(res.data) || hostnameOf(candidate) }]
      }
    } catch (e) {
      console.warn(`[discoverFeeds] Probe ${candidate} failed:`, e.message)
    }
  }

  // There used to be a feedsearch.dev call here as a last resort. Removed, and the reason
  // matters if anyone is tempted to bring it back: the API works — in a BROWSER. It sits
  // behind a Cloudflare interactive challenge, so any client that cannot run the JS gets a
  // 403 "Just a moment…" page instead of JSON. That is every path we have: CapacitorHttp is
  // an HttpURLConnection, the dev proxy is a fetch in Node. Verified with a real Chrome
  // user-agent and referer — still 403. Going through the app's WebView would not help
  // either: that is a CORS request, and the challenge page sends no CORS headers.
  //
  // So it found nothing, while handing the hostname of every site the user searched to a
  // third party. A data leak with no upside is not a fallback.
  return []
}

export async function discoverFeedUrl(inputUrl) {
  const [first] = await discoverFeeds(inputUrl)
  return first?.url || null
}

function isFeedContent(text) {
  // Strip BOM (U+FEFF) before trimming
  const t = text.replace(/^﻿/, '').trimStart()
  return t.startsWith('<?xml') || t.startsWith('<rss') || t.startsWith('<feed') || t.startsWith('<atom')
}

/**
 * Parsed as HTML, not matched with a regex: real pages write <link> tags with
 * unquoted attributes (spektrum.de does), which no attribute regex survives.
 */
function extractFeedLinks(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const seen = new Set()
  const feeds = []

  for (const link of doc.querySelectorAll('link[href]')) {
    const type = (link.getAttribute('type') || '').toLowerCase()
    if (!type.includes('rss+xml') && !type.includes('atom+xml')) continue

    let href
    try {
      href = new URL(link.getAttribute('href'), baseUrl).href
    } catch {
      continue
    }
    if (seen.has(href)) continue

    seen.add(href)
    feeds.push({ url: href, title: (link.getAttribute('title') || '').trim() || hostnameOf(href) })
  }

  return feeds
}

function readFeedTitle(xmlString) {
  try {
    return parseFeedString(xmlString).title || ''
  } catch {
    return ''
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
