import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import de from '../src/i18n/de.js'
import en from '../src/i18n/en.js'

const SRC = join(process.cwd(), 'src')

function walk(dir) {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const SOURCE_FILES = walk(SRC).filter(file => /\.(vue|js)$/.test(file) && !file.includes(`${'i18n'}`))

function flatten(messages, prefix = '') {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object' ? flatten(value, path) : [path]
  })
}

/**
 * Every `$t('…')` with a literal key. Template literals with a `${…}` in them are dynamic
 * (`settings.karakeep.errors.${code}`) and cannot be resolved statically — the namespace
 * test below covers those instead.
 */
function staticKeysIn(source) {
  return [...source.matchAll(/\$t\(\s*['"`]([^'"`$]+)['"`]/g)].map(match => match[1])
}

describe('i18n catalogues', () => {
  it('defines exactly the same keys in de and en', () => {
    const deKeys = flatten(de).sort()
    const enKeys = flatten(en).sort()

    expect(deKeys.filter(key => !enKeys.includes(key)), 'missing in en').toEqual([])
    expect(enKeys.filter(key => !deKeys.includes(key)), 'missing in de').toEqual([])
  })

  it('has a translation for every key the app asks for', () => {
    const known = new Set(flatten(de))
    const missing = []

    for (const file of SOURCE_FILES) {
      for (const key of staticKeysIn(readFileSync(file, 'utf8'))) {
        if (!known.has(key)) missing.push(`${key} (${file.slice(SRC.length + 1)})`)
      }
    }

    expect(missing).toEqual([])
  })
})

/**
 * The bug this pins down: KaraKeep and Linkwarden used to render their buttons, toasts and
 * error messages from `settings.sync.*` — which is not a shared namespace, it is the WebDAV
 * section. So the KaraKeep page told you "No WebDAV server set up yet", and a rejected API
 * key came back as a rejected username and password.
 *
 * Each sync page now owns its texts, and this test refuses to let one borrow from another.
 */
describe('the sync pages use their own i18n namespace', () => {
  const PAGES = {
    'WebdavSettings.vue': 'sync',
    'KarakeepSettings.vue': 'karakeep',
    'LinkwardenSettings.vue': 'linkwarden',
    'InstapaperSettings.vue': 'instapaper',
  }
  const SYNC_NAMESPACES = Object.values(PAGES)

  for (const [file, own] of Object.entries(PAGES)) {
    it(`${file} only reads settings.${own}.*`, () => {
      // Comments are prose about the bug and name the other namespaces on purpose.
      const source = readFileSync(join(SRC, 'pages', 'settings', file), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      const referenced = [...source.matchAll(/settings\.([a-zA-Z]+)\./g)].map(match => match[1])
      const foreign = [...new Set(referenced)].filter(
        namespace => SYNC_NAMESPACES.includes(namespace) && namespace !== own,
      )

      expect(foreign, `${file} borrows from another sync target`).toEqual([])
      expect(referenced).toContain(own)
    })
  }

  // Same shape everywhere: whatever one page says in a situation, the others say too —
  // in their own words. A missing key here is a page that would render a raw key path.
  it('gives all four targets the same set of texts', () => {
    const shared = [
      'title', 'hint', 'enabled', 'lastSync', 'never',
      'test', 'testOk', 'syncNow', 'done', 'notConfigured',
    ]
    const errors = [
      'unauthorized', 'forbidden', 'notFound', 'conflict', 'rateLimited', 'aborted',
      'serverError', 'networkError', 'invalidPayload', 'requestFailed', 'notConfigured',
    ]

    for (const locale of [de, en]) {
      for (const namespace of ['sync', 'karakeep', 'linkwarden', 'instapaper']) {
        const section = locale.settings[namespace]
        for (const key of shared) {
          expect(section[key], `settings.${namespace}.${key}`).toBeTruthy()
        }
        for (const key of errors) {
          expect(section.errors[key], `settings.${namespace}.errors.${key}`).toBeTruthy()
        }
      }
    }
  })

  // The error codes the sync modules throw are mapped through SYNC_ERROR_KEYS — every code
  // it maps must land on a real message in every target's namespace.
  it('has a message for every mapped sync error code', async () => {
    const { SYNC_ERROR_KEYS } = await import('../src/utils/syncErrors.js')

    for (const locale of [de, en]) {
      for (const namespace of ['sync', 'karakeep', 'linkwarden', 'instapaper']) {
        for (const key of Object.values(SYNC_ERROR_KEYS)) {
          expect(
            locale.settings[namespace].errors[key],
            `settings.${namespace}.errors.${key}`,
          ).toBeTruthy()
        }
      }
    }
  })
})
