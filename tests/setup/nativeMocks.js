import { vi } from 'vitest'

/**
 * In-memory stand-ins for the native plugins that have no usable web fallback under
 * jsdom (Filesystem's web build needs IndexedDB). Shared by every test file; a test that
 * cares about the contents imports `__fs` / `__secure` from the mocked module.
 */
vi.mock('@capacitor/filesystem', () => {
  const files = new Map()
  const notFound = path =>
    Object.assign(new Error(`File does not exist: ${path}`), { code: 'OS-PLUG-FILE-0008' })
  return {
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    __fs: files,
    Filesystem: {
      readFile: vi.fn(async ({ path }) => {
        if (!files.has(path)) throw notFound(path)
        return { data: files.get(path) }
      }),
      writeFile: vi.fn(async ({ path, data }) => {
        files.set(path, data)
        return { uri: path }
      }),
      deleteFile: vi.fn(async ({ path }) => {
        if (!files.delete(path)) throw notFound(path)
      }),
      rename: vi.fn(async ({ from, to }) => {
        if (!files.has(from)) throw notFound(from)
        files.set(to, files.get(from))
        files.delete(from)
      }),
    },
  }
})

vi.mock('@aparajita/capacitor-secure-storage', () => {
  const items = new Map()
  return {
    __secure: items,
    SecureStorage: {
      getItem: vi.fn(async key => (items.has(key) ? items.get(key) : null)),
      setItem: vi.fn(async (key, value) => {
        items.set(key, value)
      }),
      removeItem: vi.fn(async key => {
        items.delete(key)
      }),
    },
  }
})
