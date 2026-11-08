import { CapacitorHttp } from '@capacitor/core'
import { debug } from './log.js'

// Same-origin dev proxy, served by the Vite middleware in vite.config.mjs.
// Relative on purpose: it keeps working no matter which port Vite ends up on.
const DEV_PROXY_PATH = '/__proxy'

// Feeds and article pages. Without a limit, Android's HttpURLConnection waits forever,
// and one dead server held `refreshing` — and with it every later refresh — hostage.
export const CONNECT_TIMEOUT_MS = 15000
export const READ_TIMEOUT_MS = 30000

export function getHttpTransport() {
  return import.meta.env.DEV ? 'proxy' : 'network'
}

export function buildDevProxyUrl(url) {
  return `${DEV_PROXY_PATH}?url=${encodeURIComponent(url)}`
}

/**
 * An AbortSignal that fires after `ms`, or as soon as `parent` fires. Hand-rolled
 * instead of `AbortSignal.any()`/`AbortSignal.timeout()`: minSdk 26 means WebViews old
 * enough to lack both. `clear()` stops the timer once the request is done.
 */
export function timeoutSignal(ms, parent) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const onParentAbort = () => controller.abort()

  if (parent) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
      parent?.removeEventListener?.('abort', onParentAbort)
    },
  }
}

function defaultHeaders() {
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': (navigator.languages || [navigator.language]).join(','),
  }
}

export async function httpGet(url, extraHeaders = {}) {
  if (import.meta.env.DEV) {
    const proxyUrl = buildDevProxyUrl(url)
    debug('[http] GET via proxy', { url, proxyUrl })

    const timeout = timeoutSignal(CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS)
    try {
      const res = await fetch(proxyUrl, {
        headers: { ...defaultHeaders(), ...extraHeaders },
        signal: timeout.signal,
      })
      debug('[http] GET via proxy:response', { url, status: res.status })
      return { status: res.status, data: await res.text() }
    } finally {
      timeout.clear()
    }
  }

  debug('[http] GET via network', { url })
  return CapacitorHttp.get({
    url,
    headers: {
      'User-Agent': navigator.userAgent,
      ...defaultHeaders(),
      ...extraHeaders,
    },
    connectTimeout: CONNECT_TIMEOUT_MS,
    readTimeout: READ_TIMEOUT_MS,
  })
}
