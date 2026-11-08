import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/storage.js', () => {
  const prefs = new Map()
  return {
    __prefs: prefs,
    storageGet: vi.fn(async key => (prefs.has(key) ? JSON.parse(JSON.stringify(prefs.get(key))) : null)),
    storageSet: vi.fn(async (key, value) => { prefs.set(key, JSON.parse(JSON.stringify(value))) }),
    storageRemove: vi.fn(async key => { prefs.delete(key) }),
    storageRemoveByPrefix: vi.fn(async () => 0),
  }
})

const { __prefs } = await import('../src/utils/storage.js')
const { __secure, SecureStorage } = await import('@aparajita/capacitor-secure-storage')
const { splitSecrets, _resetSecretCache } = await import('../src/utils/secretStorage.js')
const { store } = await import('../src/store/index.js')

beforeEach(() => {
  __prefs.clear()
  __secure.clear()
  _resetSecretCache()
  vi.clearAllMocks()
})

describe('secrets', () => {
  it('splitSecrets blanks every secret and leaves the rest alone', () => {
    const { settings, secrets } = splitSecrets({
      theme: 'dark',
      ai: { apiKey: 'sk-1', model: 'm' },
      webdav: { password: 'pw', url: 'https://dav.example' },
      karakeep: { apiKey: 'kk' },
      linkwarden: { apiKey: 'lw' },
    })
    expect(settings.ai).toEqual({ apiKey: '', model: 'm' })
    expect(settings.webdav).toEqual({ password: '', url: 'https://dav.example' })
    expect(JSON.stringify(settings)).not.toMatch(/sk-1|pw"|kk|lw/)
    expect(secrets).toEqual({ 'ai.apiKey': 'sk-1', 'webdav.password': 'pw', 'karakeep.apiKey': 'kk', 'linkwarden.apiKey': 'lw' })
  })

  it('the settings blob never holds a key; the secure store does', async () => {
    await store.setAiSettings({ apiKey: 'sk-secret' })

    expect(JSON.stringify(__prefs.get('quell:settings'))).not.toContain('sk-secret')
    expect(__secure.get('quell.secret.ai.apiKey')).toBe('sk-secret')
  })

  it('moves keys out of a blob written by an older version', async () => {
    __prefs.set('quell:settings', { theme: 'dark', webdav: { url: 'https://dav.example', password: 'old-pw' } })
    store.settings.webdav.password = ''

    await store.loadSettings()

    expect(store.settings.webdav.password).toBe('old-pw')
    expect(__secure.get('quell.secret.webdav.password')).toBe('old-pw')
    expect(JSON.stringify(__prefs.get('quell:settings'))).not.toContain('old-pw')
  })

  it('a settings save that changes no secret does not touch the secure store', async () => {
    await store.setAiSettings({ apiKey: 'sk-1' })
    SecureStorage.setItem.mockClear()
    SecureStorage.removeItem.mockClear()

    await store.setShowQuelled(true)

    expect(SecureStorage.setItem).not.toHaveBeenCalled()
    expect(SecureStorage.removeItem).not.toHaveBeenCalled()
  })
})
