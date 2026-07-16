import { CapacitorHttp } from '@capacitor/core'

// Same-origin dev proxy, served by the Vite middleware in vite.config.js.
// Relative on purpose: it keeps working no matter which port Vite ends up on.
const DEV_PROXY_PATH = '/__proxy'

export function getHttpTransport() {
  return import.meta.env.DEV ? 'proxy' : 'network'
}

export function buildDevProxyUrl(url) {
  return `${DEV_PROXY_PATH}?url=${encodeURIComponent(url)}`
}

export async function httpGet(url, extraHeaders = {}) {
  if (import.meta.env.DEV) {
    const proxyUrl = buildDevProxyUrl(url)
    console.info('[http] GET via proxy', { url, proxyUrl })

    const res = await fetch(proxyUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': (navigator.languages || [navigator.language]).join(','),
        ...extraHeaders,
      },
    })

    console.info('[http] GET via proxy:response', { url, status: res.status })
    return { status: res.status, data: await res.text() }
  }

  console.info('[http] GET via network', { url })
  return CapacitorHttp.get({
    url,
    headers: {
      'User-Agent': navigator.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': (navigator.languages || [navigator.language]).join(','),
      ...extraHeaders,
    },
  })
}
