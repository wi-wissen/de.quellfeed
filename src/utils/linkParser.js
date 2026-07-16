import { httpGet } from './http.js'

/**
 * Reads the metadata of a single web page so it can be stored as a standalone
 * article — the manual counterpart to an article arriving through a feed.
 */
export async function fetchLinkMetadata(inputUrl) {
  const url = normalizeUrl(inputUrl)
  const res = await httpGet(url)
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)

  const doc = new DOMParser().parseFromString(res.data, 'text/html')
  const canonical = absoluteUrl(meta(doc, 'og:url') || linkHref(doc, 'canonical'), url) || url

  return {
    url: canonical,
    title: meta(doc, 'og:title') || meta(doc, 'twitter:title') || textOf(doc, 'title') || hostnameOf(canonical),
    description: (meta(doc, 'og:description') || meta(doc, 'twitter:description') || meta(doc, 'description') || '').slice(0, 280),
    image: absoluteUrl(meta(doc, 'og:image') || meta(doc, 'twitter:image'), canonical),
    publishedAt: parseDate(meta(doc, 'article:published_time') || meta(doc, 'og:article:published_time')),
    source: meta(doc, 'og:site_name') || hostnameOf(canonical),
  }
}

export function normalizeUrl(inputUrl) {
  const raw = String(inputUrl || '').trim()
  if (!raw) throw new Error('empty_url')

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = new URL(withProtocol) // throws on garbage input, which the caller reports as invalid_url
  return url.href
}

function meta(doc, name) {
  const el =
    doc.querySelector(`meta[property="${name}"]`) ||
    doc.querySelector(`meta[name="${name}"]`)
  return (el?.getAttribute('content') || '').trim()
}

function linkHref(doc, rel) {
  return (doc.querySelector(`link[rel="${rel}"]`)?.getAttribute('href') || '').trim()
}

function textOf(doc, selector) {
  return (doc.querySelector(selector)?.textContent || '').trim()
}

function absoluteUrl(value, baseUrl) {
  if (!value) return null
  try {
    return new URL(value, baseUrl).href
  } catch {
    return null
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function parseDate(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
