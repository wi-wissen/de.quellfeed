import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InAppBrowser } from '@capgo/inappbrowser'
import { Capacitor } from '@capacitor/core'
import {
  DEFAULT_PAYWALL_SETTINGS,
  isPaywallSupported,
  normalizePaywallDomain,
  findSiteForUrl,
  createPaywallSite,
  openLoginBrowser,
  closeLoginBrowser,
  hasSessionFor,
  clearSessionFor,
} from '../src/utils/paywall.js'

vi.mock('@capgo/inappbrowser', () => ({
  InAppBrowser: {
    openWebView: vi.fn(),
    close: vi.fn(),
    addListener: vi.fn(),
    getCookies: vi.fn(),
    clearCookies: vi.fn(),
    executeScript: vi.fn(),
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
    isPluginAvailable: vi.fn(),
  },
}))

// Every registered listener, so a test can fire the native event and — more to the
// point — check afterwards that its handle was removed again.
let listeners = []

function handlesFor(eventName) {
  return listeners.filter(l => l.eventName === eventName)
}

function fireCloseEvent(url = 'https://www.spiegel.de/konto') {
  // The plugin emits closeEvent to every listener that is still registered — which
  // is exactly what a leak would show up as.
  handlesFor('closeEvent').forEach(l => l.listenerFunc({ url }))
}

function fireUrlChange(url) {
  handlesFor('urlChangeEvent').forEach(l => l.listenerFunc({ url }))
}

/** Pretends we are on a device with the plugin present. */
function goNative() {
  vi.stubEnv('DEV', false)
  Capacitor.isNativePlatform.mockReturnValue(true)
  Capacitor.isPluginAvailable.mockReturnValue(true)
}

beforeEach(() => {
  listeners = []
  vi.clearAllMocks()

  InAppBrowser.addListener.mockImplementation((eventName, listenerFunc) => {
    const handle = { eventName, listenerFunc, remove: vi.fn(async () => {
      listeners = listeners.filter(l => l !== handle)
    }) }
    listeners.push(handle)
    return Promise.resolve(handle)
  })
  InAppBrowser.openWebView.mockResolvedValue(undefined)
  InAppBrowser.close.mockResolvedValue(undefined)
  InAppBrowser.clearCookies.mockResolvedValue(undefined)
  InAppBrowser.getCookies.mockResolvedValue({})
})

afterEach(async () => {
  // Never let one test's open WebView leak into the next.
  await closeLoginBrowser().catch(() => {})
  vi.unstubAllEnvs()
})

describe('DEFAULT_PAYWALL_SETTINGS', () => {
  it('starts with no sites', () => {
    expect(DEFAULT_PAYWALL_SETTINGS).toEqual({ sites: [] })
  })
})

describe('isPaywallSupported', () => {
  it('is false in the dev build even when everything else is there', () => {
    vi.stubEnv('DEV', true)
    Capacitor.isNativePlatform.mockReturnValue(true)
    Capacitor.isPluginAvailable.mockReturnValue(true)

    expect(isPaywallSupported()).toBe(false)
  })

  it('is false in a web build (not a native platform)', () => {
    vi.stubEnv('DEV', false)
    Capacitor.isNativePlatform.mockReturnValue(false)
    Capacitor.isPluginAvailable.mockReturnValue(true)

    expect(isPaywallSupported()).toBe(false)
  })

  it('is false when the plugin is missing', () => {
    vi.stubEnv('DEV', false)
    Capacitor.isNativePlatform.mockReturnValue(true)
    Capacitor.isPluginAvailable.mockReturnValue(false)

    expect(isPaywallSupported()).toBe(false)
  })

  it('is true on a native platform with the plugin', () => {
    goNative()
    expect(isPaywallSupported()).toBe(true)
  })
})

describe('normalizePaywallDomain', () => {
  it('strips www.', () => {
    expect(normalizePaywallDomain('https://www.spiegel.de')).toBe('spiegel.de')
  })

  it('keeps a non-www subdomain', () => {
    expect(normalizePaywallDomain('https://plus.spiegel.de')).toBe('plus.spiegel.de')
  })

  it('drops the path', () => {
    expect(normalizePaywallDomain('https://www.zeit.de/politik/2026-07/artikel')).toBe('zeit.de')
  })

  it('drops the port', () => {
    expect(normalizePaywallDomain('http://localhost.dev:8080/login')).toBe('localhost.dev')
  })

  it('accepts a bare domain without a scheme', () => {
    expect(normalizePaywallDomain('www.faz.net')).toBe('faz.net')
  })

  it('lowercases', () => {
    expect(normalizePaywallDomain('HTTPS://WWW.SPIEGEL.DE/Politik')).toBe('spiegel.de')
  })

  it('throws invalid_url on empty input', () => {
    expect(() => normalizePaywallDomain('   ')).toThrow('invalid_url')
    expect(() => normalizePaywallDomain(null)).toThrow('invalid_url')
  })

  it('throws invalid_url on a hostname without a dot', () => {
    // `new URL('https://nonsense')` parses fine and yields the host "nonsense" —
    // letting that through would make findSiteForUrl match garbage.
    expect(() => normalizePaywallDomain('nonsense')).toThrow('invalid_url')
  })

  it('throws invalid_url on garbage', () => {
    expect(() => normalizePaywallDomain('http://')).toThrow('invalid_url')
  })
})

describe('findSiteForUrl', () => {
  const sites = [
    { domain: 'spiegel.de', title: 'Spiegel' },
    { domain: 'faz.net', title: 'FAZ' },
  ]

  it('matches the plain domain', () => {
    expect(findSiteForUrl(sites, 'https://www.spiegel.de/politik/a-123')?.domain).toBe('spiegel.de')
  })

  it('matches a subdomain against the registered domain', () => {
    // The whole point: the login form is on spiegel.de, the paywalled article on
    // plus.spiegel.de — and a Domain=.spiegel.de cookie is sent to both.
    expect(findSiteForUrl(sites, 'https://plus.spiegel.de/artikel')?.domain).toBe('spiegel.de')
  })

  it('does not match a domain that merely ends with the same characters', () => {
    // The endsWith() trap: notspiegel.de is a different site entirely.
    expect(findSiteForUrl(sites, 'https://notspiegel.de/artikel')).toBeNull()
  })

  it('does not match the parent domain of a registered subdomain', () => {
    // A host-only cookie set by plus.spiegel.de is not sent to spiegel.de.
    const subOnly = [{ domain: 'plus.spiegel.de' }]
    expect(findSiteForUrl(subOnly, 'https://spiegel.de/artikel')).toBeNull()
  })

  it('prefers the most specific entry when several match', () => {
    const both = [{ domain: 'spiegel.de' }, { domain: 'plus.spiegel.de' }]
    expect(findSiteForUrl(both, 'https://plus.spiegel.de/artikel')?.domain).toBe('plus.spiegel.de')
  })

  it('returns null for an unknown domain', () => {
    expect(findSiteForUrl(sites, 'https://taz.de/artikel')).toBeNull()
  })

  it('returns null instead of throwing on a garbage url', () => {
    expect(findSiteForUrl(sites, 'http://')).toBeNull()
    expect(findSiteForUrl(sites, '')).toBeNull()
  })

  it('survives an empty or malformed site list', () => {
    expect(findSiteForUrl([], 'https://spiegel.de')).toBeNull()
    expect(findSiteForUrl(null, 'https://spiegel.de')).toBeNull()
    expect(findSiteForUrl([{ domain: '' }, {}], 'https://spiegel.de')).toBeNull()
  })
})

describe('createPaywallSite', () => {
  it('normalizes the domain and keeps the login url', () => {
    const site = createPaywallSite({ loginUrl: 'https://www.spiegel.de/fuermich/login', title: 'Spiegel' })

    expect(site.domain).toBe('spiegel.de')
    expect(site.loginUrl).toBe('https://www.spiegel.de/fuermich/login')
    expect(site.title).toBe('Spiegel')
    expect(site.addedAt).toBeTypeOf('number')
    expect(site.lastLoginAt).toBeTypeOf('number')
  })

  it('falls back to the domain as the title', () => {
    expect(createPaywallSite({ loginUrl: 'https://www.faz.net/login' }).title).toBe('faz.net')
  })

  it('throws invalid_url on garbage', () => {
    expect(() => createPaywallSite({ loginUrl: 'nonsense' })).toThrow('invalid_url')
  })

  it('produces an entry that findSiteForUrl actually matches', () => {
    const site = createPaywallSite({ loginUrl: 'https://www.spiegel.de/fuermich/login' })
    expect(findSiteForUrl([site], 'https://plus.spiegel.de/artikel/a-1')?.domain).toBe('spiegel.de')
  })
})

describe('openLoginBrowser', () => {
  it('throws unsupported in the dev build', async () => {
    vi.stubEnv('DEV', true)
    Capacitor.isNativePlatform.mockReturnValue(true)
    Capacitor.isPluginAvailable.mockReturnValue(true)

    await expect(openLoginBrowser({ url: 'https://spiegel.de' })).rejects.toThrow('unsupported')
    expect(InAppBrowser.openWebView).not.toHaveBeenCalled()
  })

  it('throws unsupported when the plugin is missing', async () => {
    vi.stubEnv('DEV', false)
    Capacitor.isNativePlatform.mockReturnValue(true)
    Capacitor.isPluginAvailable.mockReturnValue(false)

    await expect(openLoginBrowser({ url: 'https://spiegel.de' })).rejects.toThrow('unsupported')
    expect(InAppBrowser.openWebView).not.toHaveBeenCalled()
  })

  it('throws invalid_url before touching the plugin', async () => {
    goNative()

    await expect(openLoginBrowser({ url: 'nonsense' })).rejects.toThrow('invalid_url')
    expect(InAppBrowser.openWebView).not.toHaveBeenCalled()
    expect(InAppBrowser.addListener).not.toHaveBeenCalled()
  })

  it('opens the webview on the login url', async () => {
    goNative()
    await openLoginBrowser({ url: 'https://www.spiegel.de/login', title: 'Spiegel' })

    expect(InAppBrowser.openWebView).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://www.spiegel.de/login', title: 'Spiegel' }),
    )
  })

  it('calls onClose with the last url when the user closes the webview', async () => {
    goNative()
    const onClose = vi.fn()
    await openLoginBrowser({ url: 'https://spiegel.de/login', onClose })

    fireUrlChange('https://spiegel.de/konto')
    fireCloseEvent('https://spiegel.de/konto')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))

    expect(onClose).toHaveBeenCalledWith({ url: 'https://spiegel.de/konto' })
  })

  // ── The leak ──────────────────────────────────────────────────────────────
  it('removes its listeners after the webview is closed', async () => {
    goNative()
    await openLoginBrowser({ url: 'https://spiegel.de/login', onClose: vi.fn() })

    expect(listeners.length).toBeGreaterThan(0)

    fireCloseEvent()
    await vi.waitFor(() => expect(listeners).toHaveLength(0))
  })

  it('does not stack listeners when the login is opened again and again', async () => {
    goNative()

    for (let i = 0; i < 3; i += 1) {
      await openLoginBrowser({ url: 'https://spiegel.de/login', onClose: vi.fn() })
      const openHandles = listeners.length
      fireCloseEvent()
      await vi.waitFor(() => expect(listeners).toHaveLength(0))
      // Every round registers the same number of listeners — never i * n.
      expect(openHandles).toBe(2)
    }

    expect(handlesFor('closeEvent')).toHaveLength(0)
  })

  it('does not fire onClose twice when the same open is closed twice', async () => {
    goNative()
    const onClose = vi.fn()
    await openLoginBrowser({ url: 'https://spiegel.de/login', onClose })

    fireCloseEvent()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))

    // A second native closeEvent (or a close() on top of the user's tap) must not
    // re-run the callback — the store would add the site twice.
    fireCloseEvent()
    await closeLoginBrowser()

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cleans up the previous webview when a second login is opened without closing the first', async () => {
    goNative()
    const first = vi.fn()
    await openLoginBrowser({ url: 'https://spiegel.de/login', onClose: first })
    const second = vi.fn()
    await openLoginBrowser({ url: 'https://faz.net/login', onClose: second })

    expect(listeners).toHaveLength(2)
    expect(InAppBrowser.close).toHaveBeenCalled()

    // The stale listener of the first open is gone, so its callback cannot fire.
    fireCloseEvent()
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    expect(first).not.toHaveBeenCalled()
  })

  it('leaves no listeners behind when openWebView fails', async () => {
    goNative()
    InAppBrowser.openWebView.mockRejectedValue(new Error('boom'))

    await expect(openLoginBrowser({ url: 'https://spiegel.de/login' })).rejects.toThrow('boom')
    expect(listeners).toHaveLength(0)
  })
})

describe('closeLoginBrowser', () => {
  it('does nothing when no webview is open', async () => {
    goNative()
    await expect(closeLoginBrowser()).resolves.toBeUndefined()
    expect(InAppBrowser.close).not.toHaveBeenCalled()
  })

  it('closes the webview and removes the listeners', async () => {
    goNative()
    const onClose = vi.fn()
    await openLoginBrowser({ url: 'https://spiegel.de/login', onClose })

    await closeLoginBrowser()

    expect(InAppBrowser.close).toHaveBeenCalled()
    expect(listeners).toHaveLength(0)
  })
})

describe('hasSessionFor', () => {
  it('is false when unsupported — and never asks the plugin', async () => {
    vi.stubEnv('DEV', true)

    await expect(hasSessionFor('spiegel.de')).resolves.toBe(false)
    // The web stub of getCookies() resolves with the OPTIONS object it was handed,
    // so an unguarded call would count `url`/`includeHttpOnly` as cookies and report
    // a session that does not exist.
    expect(InAppBrowser.getCookies).not.toHaveBeenCalled()
  })

  it('is true when the native jar holds cookies for the domain', async () => {
    goNative()
    InAppBrowser.getCookies.mockResolvedValue({ sessionid: 'abc' })

    await expect(hasSessionFor('https://www.spiegel.de/politik')).resolves.toBe(true)
    expect(InAppBrowser.getCookies).toHaveBeenCalledWith({
      url: 'https://spiegel.de/',
      includeHttpOnly: true,
    })
  })

  it('is false when the jar is empty', async () => {
    goNative()
    InAppBrowser.getCookies.mockResolvedValue({})

    await expect(hasSessionFor('spiegel.de')).resolves.toBe(false)
  })

  it('is false instead of throwing on a garbage domain or a plugin error', async () => {
    goNative()
    await expect(hasSessionFor('nonsense')).resolves.toBe(false)

    InAppBrowser.getCookies.mockRejectedValue(new Error('Invalid URL'))
    await expect(hasSessionFor('spiegel.de')).resolves.toBe(false)
  })
})

describe('clearSessionFor', () => {
  it('clears the cookies of the normalized domain', async () => {
    goNative()
    await clearSessionFor('https://www.spiegel.de/konto')

    expect(InAppBrowser.clearCookies).toHaveBeenCalledWith({ url: 'https://spiegel.de/' })
  })

  it('throws unsupported in the dev build', async () => {
    vi.stubEnv('DEV', true)

    await expect(clearSessionFor('spiegel.de')).rejects.toThrow('unsupported')
    expect(InAppBrowser.clearCookies).not.toHaveBeenCalled()
  })
})
