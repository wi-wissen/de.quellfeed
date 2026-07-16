import { storageGet, storageSet, storageRemove, storageRemoveByPrefix } from './storage.js'

const CACHE_PREFIX = 'domainConfig:'

// Configs live on a static host so they can be fixed without an app release. That
// only pays off if clients actually come back for them — hence a TTL. 28 days is
// slow enough to be invisible, fast enough that a fix reaches everyone in a month.
// A user who is unhappy with an article's rendering also gets a forced refetch via
// "reload article", which is the impatient path.
export const CONFIG_TTL_MS = 28 * 24 * 60 * 60 * 1000

const cache = {}

function getCacheKey(domain, baseUrl = '') {
  return `${normalizeConfigBaseUrl(baseUrl)}:${domain}`
}

function getStorageKey(domain, baseUrl = '') {
  return CACHE_PREFIX + getCacheKey(domain, baseUrl)
}

function isFresh(entry, now) {
  return Boolean(entry) && now - entry.fetchedAt < CONFIG_TTL_MS
}

export function normalizeConfigBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

export function getDefaultConfigBaseUrl() {
  return normalizeConfigBaseUrl(import.meta.env.VITE_CONFIG_BASE_URL)
}

export async function invalidateDomainConfig(domain, baseUrl = import.meta.env.VITE_CONFIG_BASE_URL) {
  delete cache[getCacheKey(domain, baseUrl)]
  await storageRemove(getStorageKey(domain, baseUrl))
}

export async function clearDomainConfigCache() {
  Object.keys(cache).forEach(key => delete cache[key])
  return storageRemoveByPrefix(CACHE_PREFIX)
}

/**
 * Fetches a domain config, cached with a TTL.
 *
 * Remote is the only source — there is no bundled copy. That costs nothing in
 * practice: fetching an article needs the network anyway, and a *saved* article is
 * read from its cached HTML and never asks for a config at all. So there is no
 * moment where you hold an article but lack its config.
 *
 * A 404 is cached too. Most domains have no config, and without a negative entry
 * every single article on those domains would hit the network again.
 */
export async function getDomainConfig(domain, baseUrl = import.meta.env.VITE_CONFIG_BASE_URL, options = {}) {
  const cacheKey = getCacheKey(domain, baseUrl)
  const storageKey = getStorageKey(domain, baseUrl)
  const now = Date.now()

  if (options.forceRefresh) await invalidateDomainConfig(domain, baseUrl)

  if (isFresh(cache[cacheKey], now)) return cache[cacheKey].config

  const stored = await storageGet(storageKey)
  if (isFresh(stored, now)) {
    cache[cacheKey] = stored
    return stored.config
  }

  const normalizedBaseUrl = normalizeConfigBaseUrl(baseUrl)
  if (!normalizedBaseUrl) return stored?.config ?? null

  try {
    const res = await fetch(`${normalizedBaseUrl}/${domain}.json`)

    if (res.ok || res.status === 404) {
      const entry = { config: res.ok ? await res.json() : null, fetchedAt: now }
      cache[cacheKey] = entry
      await storageSet(storageKey, entry)
      return entry.config
    }
  } catch {
    // Offline or the host is down. A stale config beats no config, so keep serving
    // the expired one rather than degrading the reading view to bare Readability.
  }

  if (stored) {
    cache[cacheKey] = stored
    return stored.config
  }
  return null
}
