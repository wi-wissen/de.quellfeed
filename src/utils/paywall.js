// "Logged-in sites" — the user signs in to a newspaper he has a *legitimate
// subscription* for, inside an in-app WebView. Afterwards the normal article
// fetch carries the session cookies and the server hands us the full text
// instead of the paywall teaser. This is not a paywall bypass: the user
// authenticates with his own credentials and the server serves him willingly.
//
// ── Why this works without us touching a single cookie ───────────────────────
// Android: @capgo/inappbrowser opens a real android.webkit.WebView *in the app
// process*, so everything it stores lands in the one global
// android.webkit.CookieManager jar. Capacitor registers CapacitorCookies as the
// default java.net.CookieHandler, and CapacitorHttp (HttpURLConnection) consults
// that handler automatically. src/utils/http.js therefore already sends the
// session cookies — there is nothing to pass around, and nothing to add there.
// HttpOnly is a non-issue because the whole handoff happens natively; the JS
// route via document.cookie would have failed exactly there.
//
// Deliberately NOT used:
//   • @capacitor/browser — Chrome Custom Tabs / SFSafariViewController share the
//     cookie jar of Chrome resp. Safari, NOT the app's. The session would never
//     reach CapacitorHttp.
//   • a hand-set `Cookie` header on CapacitorHttp — the header gets stripped
//     (ionic-team/capacitor#7013). Do not fight the platform; the automatic path
//     is the one that works.
//
// ── The one caveat the UI MUST show the user ─────────────────────────────────
// CapacitorCookies.load() calls removeSessionCookies() on app start (and in
// handleOnDestroy()). Cookies without an `Expires` attribute therefore do NOT
// survive an app restart. The user has to tick "keep me signed in" / "stay
// logged in" on the newspaper's login form, otherwise he is silently logged out
// the next time the app is launched. → i18n key: settings.paywall.hints.stayLoggedIn
//
// In the dev web build none of this exists (articles go through the Vite proxy in
// src/utils/http.js, and the plugin only has a no-op web stub that resolves as if
// it had worked). Every entry point below therefore refuses loudly with
// `unsupported` rather than pretending to succeed.

import { Capacitor } from '@capacitor/core'
import { InAppBrowser } from '@capgo/inappbrowser'

export const DEFAULT_PAYWALL_SETTINGS = {
  // [{ domain, title, loginUrl, addedAt, lastLoginAt }]
  sites: [],
}

// The name @capgo/inappbrowser registers itself under (dist/esm/index.js).
const PLUGIN_NAME = 'InAppBrowser'

/**
 * Whether a paywall login can actually be performed.
 *
 * False in the dev/web build: the plugin's web stub (dist/esm/web.js) resolves
 * every method with a console.log and does nothing, and the dev article fetch runs
 * through the Vite proxy anyway — a session there could never reach the request.
 * Silently "succeeding" would be the worst outcome, so callers get `unsupported`.
 */
export function isPaywallSupported() {
  if (import.meta.env.DEV) return false
  if (!Capacitor.isNativePlatform?.()) return false
  if (!Capacitor.isPluginAvailable?.(PLUGIN_NAME)) return false
  return typeof InAppBrowser?.openWebView === 'function'
}

/**
 * The domain we match an article URL against: lowercase, no `www.`, no port.
 * Accepts a full URL or a bare domain ("spiegel.de", "www.spiegel.de/politik").
 *
 * @throws {Error} `invalid_url`
 */
export function normalizePaywallDomain(url) {
  const raw = String(url || '').trim()
  if (!raw) throw new Error('invalid_url')

  // Users type "spiegel.de", not "https://spiegel.de". Same trick as
  // linkParser.normalizeUrl().
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`

  let hostname
  try {
    ({ hostname } = new URL(withScheme))
  } catch {
    throw new Error('invalid_url')
  }

  const domain = hostname.toLowerCase().replace(/^www\./, '')

  // `new URL('https://foo')` happily yields the hostname "foo". A domain without a
  // dot cannot be a real site, and letting it through would make findSiteForUrl
  // match nonsense.
  if (!domain || !domain.includes('.')) throw new Error('invalid_url')

  return domain
}

/**
 * The stored site an article URL belongs to, or null.
 *
 * Subdomains match on purpose — an entry for `spiegel.de` covers `plus.spiegel.de`.
 * Two reasons:
 *   1. Without it the feature is useless: paywalled content lives on exactly those
 *      subdomains (plus.spiegel.de, epaper.faz.net, …) while the login form sits on
 *      the bare domain.
 *   2. It mirrors what the cookie jar does anyway. A login cookie with
 *      `Domain=.spiegel.de` IS sent to plus.spiegel.de, so claiming "no session
 *      here" while the browser happily sends one would be the lie.
 * The reverse does not match: an entry for `plus.spiegel.de` does not cover
 * `spiegel.de`, because a host-only cookie set by plus.spiegel.de is not sent there.
 *
 * The match is on a label boundary, so `notspiegel.de` never matches `spiegel.de`
 * — a plain endsWith() would. When several entries match, the most specific
 * (longest) one wins.
 */
export function findSiteForUrl(sites, url) {
  if (!Array.isArray(sites) || sites.length === 0) return null

  let target
  try {
    target = normalizePaywallDomain(url)
  } catch {
    return null
  }

  return sites
    .filter(site => {
      let domain
      try {
        domain = normalizePaywallDomain(site?.domain)
      } catch {
        return false
      }
      return target === domain || target.endsWith(`.${domain}`)
    })
    .sort((a, b) => String(b.domain).length - String(a.domain).length)[0] || null
}

/**
 * A stored site entry. Lives here and not in the store so that the domain is
 * normalized by the very function findSiteForUrl() matches with — a store that
 * rolled its own would drift and silently stop matching.
 *
 * @throws {Error} `invalid_url`
 */
export function createPaywallSite({ loginUrl, title = '' } = {}) {
  const domain = normalizePaywallDomain(loginUrl)
  const now = Date.now()

  return {
    domain,
    title: String(title || '').trim() || domain,
    loginUrl: String(loginUrl || '').trim(),
    addedAt: now,
    lastLoginAt: now,
  }
}

// ── The open login WebView ──────────────────────────────────────────────────
// One at a time. The handles of the previous one are removed before a new one is
// opened, otherwise every open would stack another closeEvent listener and the
// callback would fire N times on the Nth login — the classic Capacitor leak.
let session = null

async function teardown() {
  if (!session) return

  const { handles } = session
  session = null

  await Promise.all(
    handles.map(handle => Promise.resolve(handle?.remove?.()).catch(() => {})),
  )
}

/**
 * Opens the in-app WebView on a newspaper's login page.
 *
 * Everything the WebView stores goes into the app's own cookie jar, which
 * CapacitorHttp reads on the next article fetch. We neither read nor forward the
 * session ourselves.
 *
 * @param {{url: string, title?: string, onClose?: (info: {url: string}) => void}} options
 *   `onClose` fires exactly once — on the user's close/back tap and on
 *   closeLoginBrowser() alike (both platforms emit `closeEvent` in either case).
 *   It carries the last URL the WebView was on, which is what tells the caller
 *   whether the user got past the login form.
 * @returns {Promise<{close: () => Promise<void>}>}
 * @throws {Error} `unsupported` (dev/web build or plugin missing), `invalid_url`
 */
export async function openLoginBrowser({ url, title = '', onClose } = {}) {
  if (!isPaywallSupported()) throw new Error('unsupported')

  // Throws invalid_url before anything native is touched.
  normalizePaywallDomain(url)
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url).trim())
    ? String(url).trim()
    : `https://${String(url).trim()}`

  // A previous WebView may still be around (or its listeners may be).
  await closeLoginBrowser()

  const current = { handles: [], lastUrl: target }
  session = current

  const finish = async () => {
    // teardown() nulls `session`; if it already ran, this open is done and the
    // callback must not fire twice.
    if (session !== current) return
    const { lastUrl } = current
    await teardown()
    onClose?.({ url: lastUrl })
  }

  try {
    current.handles.push(
      await InAppBrowser.addListener('urlChangeEvent', event => {
        if (event?.url) current.lastUrl = event.url
      }),
      await InAppBrowser.addListener('closeEvent', event => {
        if (event?.url) current.lastUrl = event.url
        finish()
      }),
    )

    await InAppBrowser.openWebView({
      url: target,
      title: String(title || '').trim(),
      // Back/forward: a login flow is a multi-step affair (consent banner, SSO
      // redirect, 2FA) and a user who cannot go back is a user who gives up.
      toolbarType: 'navigation',
      showReloadButton: true,
    })
  } catch (err) {
    // Never leave listeners behind on a failed open.
    await teardown()
    throw err
  }

  return { close: closeLoginBrowser }
}

/**
 * Closes the login WebView and removes its listeners. Safe to call when nothing is
 * open. The native close() emits `closeEvent` itself, so the caller's `onClose`
 * still runs — the teardown here is the belt to that suspenders, because the web
 * stub emits nothing at all.
 */
export async function closeLoginBrowser() {
  if (!session) return

  try {
    await InAppBrowser.close()
  } catch {
    // Nothing open natively, or the plugin is a stub. Either way the listeners
    // below still have to go.
  }
  await teardown()
}

// ── Session state ───────────────────────────────────────────────────────────

/**
 * Whether the cookie jar holds ANY cookie for this domain.
 *
 * READ THIS BEFORE YOU PUT IT IN THE UI:
 *
 * What is reliable: reading the jar. @capgo/inappbrowser's getCookies() goes to the
 * NATIVE store on both platforms (Android: CookieManager.getInstance().getCookie(),
 * iOS: WKWebsiteDataStore.httpCookieStore.getAllCookies()), so unlike
 * CapacitorCookies.getCookies() — which is a `bridge.eval("document.cookie")` on
 * Android and therefore blind to HttpOnly — this DOES see HttpOnly session cookies.
 *
 * What is NOT reliable: concluding "the user is logged in" from it. A newspaper sets
 * cookies for anonymous visitors too (consent banner, A/B bucket, CDN, tracking), so
 * a `true` here says "this domain has been visited", not "there is a valid
 * subscription session". There is no domain-agnostic way to tell an auth cookie from
 * a consent cookie — that would need a per-site list of cookie names, which we do not
 * have and would rot instantly.
 *
 * So: `false` is meaningful (nothing at all → certainly no session), `true` is a hint.
 * The UI must present the list of logged-in sites as what the user *told* us
 * ("I signed in here"), not as a verified state, and must never render a green
 * "logged in" tick off the back of this function.
 *
 * @returns {Promise<boolean>} false when unsupported — never throws for that.
 */
export async function hasSessionFor(domain) {
  if (!isPaywallSupported()) return false

  let normalized
  try {
    normalized = normalizePaywallDomain(domain)
  } catch {
    return false
  }

  try {
    const cookies = await InAppBrowser.getCookies({
      url: `https://${normalized}/`,
      // Honoured on iOS; on Android the native jar returns HttpOnly cookies anyway.
      includeHttpOnly: true,
    })
    return Boolean(cookies) && Object.keys(cookies).length > 0
  } catch {
    return false
  }
}

/**
 * Drops all cookies for a domain — the "sign out" button of a stored site.
 * The store still has to remove its own entry; this only clears the jar.
 *
 * @throws {Error} `unsupported`, `invalid_url`
 */
export async function clearSessionFor(domain) {
  if (!isPaywallSupported()) throw new Error('unsupported')

  const normalized = normalizePaywallDomain(domain)
  await InAppBrowser.clearCookies({ url: `https://${normalized}/` })
}
