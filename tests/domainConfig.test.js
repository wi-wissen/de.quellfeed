import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getDomainConfig,
  invalidateDomainConfig,
  clearDomainConfigCache,
  normalizeConfigBaseUrl,
  CONFIG_TTL_MS,
} from '../src/utils/domainConfig.js'

// A fake Preferences store, so the module's persistence is exercised for real.
const store = new Map()

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }) => ({ value: store.has(key) ? store.get(key) : null }),
    set: async ({ key, value }) => { store.set(key, value) },
    remove: async ({ key }) => { store.delete(key) },
    keys: async () => ({ keys: [...store.keys()] }),
  },
}))

const BASE = 'https://configs.example'
const CONFIG = { selectors: { container: ['article'], remove: [] } }

function mockFetch(impl) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

function ok() {
  return { ok: true, status: 200, json: async () => CONFIG }
}

function notFound() {
  return { ok: false, status: 404, json: async () => ({}) }
}

beforeEach(async () => {
  store.clear()
  await clearDomainConfigCache()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('normalizeConfigBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeConfigBaseUrl('https://x.dev/configs///')).toBe('https://x.dev/configs')
  })

  it('survives null and undefined', () => {
    expect(normalizeConfigBaseUrl(null)).toBe('')
    expect(normalizeConfigBaseUrl(undefined)).toBe('')
  })
})

describe('getDomainConfig', () => {
  it('fetches from the configured base URL', async () => {
    const fetchMock = mockFetch(ok)

    expect(await getDomainConfig('spektrum.de', BASE)).toEqual(CONFIG)
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/spektrum.de.json`)
  })

  it('serves a second call from cache without hitting the network', async () => {
    const fetchMock = mockFetch(ok)

    await getDomainConfig('spektrum.de', BASE)
    await getDomainConfig('spektrum.de', BASE)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('persists the config, not just an in-memory entry', async () => {
    mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    const [stored] = [...store.values()].map(JSON.parse)
    expect(stored.config).toEqual(CONFIG)
    expect(stored.fetchedAt).toBe(Date.now())
  })

  // Most domains have no config. Without a negative entry, every article on those
  // domains would hit the network again.
  it('caches a 404 so it is not refetched', async () => {
    const fetchMock = mockFetch(notFound)

    expect(await getDomainConfig('nothing.example', BASE)).toBeNull()
    expect(await getDomainConfig('nothing.example', BASE)).toBeNull()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refetches once the TTL has expired', async () => {
    const fetchMock = mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    vi.advanceTimersByTime(CONFIG_TTL_MS + 1)
    await getDomainConfig('spektrum.de', BASE)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps serving within the TTL', async () => {
    const fetchMock = mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    vi.advanceTimersByTime(CONFIG_TTL_MS - 1000)
    await getDomainConfig('spektrum.de', BASE)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A stale config still beats no config — degrading to bare Readability because
  // the config host is briefly down would be a visible regression for the reader.
  it('serves a stale config when the network fails', async () => {
    const fetchMock = mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    vi.advanceTimersByTime(CONFIG_TTL_MS + 1)
    fetchMock.mockImplementation(() => { throw new Error('offline') })

    expect(await getDomainConfig('spektrum.de', BASE)).toEqual(CONFIG)
  })

  it('returns null when offline and nothing was ever cached', async () => {
    mockFetch(() => { throw new Error('offline') })

    expect(await getDomainConfig('spektrum.de', BASE)).toBeNull()
  })

  it('does not fetch at all without a base URL', async () => {
    const fetchMock = mockFetch(ok)

    expect(await getDomainConfig('spektrum.de', '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The bug this replaced: forceRefresh only dropped the in-memory entry, so the
  // stale persisted config came straight back and "reload article" changed nothing.
  it('forceRefresh drops the persisted entry too', async () => {
    const fetchMock = mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    await getDomainConfig('spektrum.de', BASE, { forceRefresh: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect([...store.keys()].length).toBe(1)
  })

  it('invalidateDomainConfig clears memory and storage', async () => {
    const fetchMock = mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)

    await invalidateDomainConfig('spektrum.de', BASE)
    expect(store.size).toBe(0)

    await getDomainConfig('spektrum.de', BASE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caches per base URL, so switching hosts does not serve the old config', async () => {
    const fetchMock = mockFetch(ok)

    await getDomainConfig('spektrum.de', BASE)
    await getDomainConfig('spektrum.de', 'https://other.example')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearDomainConfigCache empties the store', async () => {
    mockFetch(ok)
    await getDomainConfig('spektrum.de', BASE)
    expect(store.size).toBe(1)

    const cleared = await clearDomainConfigCache()

    expect(cleared).toBe(1)
    expect(store.size).toBe(0)
  })
})
