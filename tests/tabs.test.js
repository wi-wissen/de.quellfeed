import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import de from '../src/i18n/de.js'
import en from '../src/i18n/en.js'

const SRC = join(process.cwd(), 'src')

function read(...parts) {
  return readFileSync(join(SRC, ...parts), 'utf8')
}

/**
 * The tab layout is three tabs — Feed, Saved (reading list), Archive. The archive used
 * to be a segment inside the Saved tab; these tests pin that it is a tab of its own now
 * and that the segment did not quietly come back.
 */
describe('the tab bar', () => {
  const app = read('App.vue')

  it('has exactly three tab links: feed, saved, archive', () => {
    const links = [...app.matchAll(/tab-link="#([\w-]+)"/g)].map(m => m[1])
    expect(links).toEqual(['view-feed', 'view-saved', 'view-archive'])
  })

  it('backs every tab link with a view of its own', () => {
    for (const [id, url] of [
      ['view-feed', '/'],
      ['view-saved', '/saved/'],
      ['view-archive', '/archive/'],
    ]) {
      expect(app).toMatch(new RegExp(`<f7-view id="${id}"[^>]*url="${url}"`))
    }
  })

  it('labels each tab from nav.*, which exists in both languages', () => {
    for (const key of ['feed', 'saved', 'archive']) {
      expect(app).toContain(`$t('nav.${key}')`)
      expect(de.nav[key], `de nav.${key}`).toBeTruthy()
      expect(en.nav[key], `en nav.${key}`).toBeTruthy()
    }
  })

  it('routes /archive/ to the ArchivePage', () => {
    const routes = read('routes.js')
    expect(routes).toMatch(/\{ path: '\/archive\/', component: ArchivePage \}/)
  })

  it('left the segmented control behind — the archive is a tab, not a segment', () => {
    const saved = read('pages', 'SavedPage.vue')
    expect(saved).not.toContain('f7-segmented')
    expect(saved).not.toContain('segment')
    expect(saved).not.toContain('archivedArticles')
  })
})

/**
 * The app reopens on the tab the user last had open. Source-level pins for the three
 * ordering rules that make it correct: restore happens before the splash lifts (no
 * feed flashing by), the remember-listener attaches only after the restore (the
 * initial feed show must not overwrite the stored value), and only real tab ids are
 * ever written.
 */
describe('the last tab is remembered', () => {
  const app = read('App.vue')

  it('restores before the splash lifts', () => {
    expect(app.indexOf('await this.restoreLastTab()')).toBeGreaterThan(-1)
    expect(app.indexOf('await this.restoreLastTab()')).toBeLessThan(app.indexOf('this.hideSplashScreen()'))
  })

  it('only accepts the three known tab ids, reading and writing', () => {
    expect(app).toContain("const TAB_IDS = ['view-feed', 'view-saved', 'view-archive']")
    expect(app).toMatch(/TAB_IDS\.includes\(lastTab\)/)
    expect(app).toMatch(/TAB_IDS\.includes\(tabEl\?\.id\)/)
  })

  it('starts remembering only after the restore', () => {
    const restore = app.slice(app.indexOf('async restoreLastTab'))
    expect(restore.indexOf('f7.tab.show')).toBeLessThan(restore.indexOf("f7.on('tabShow'"))
  })

  it('cleans its listener up with the component', () => {
    expect(app).toContain("f7.off('tabShow', this.onTabShow)")
  })
})

/**
 * The native toast after a share-intent save used to interpolate the article title —
 * too long for a device toast. The short key carries the verdict, the page keeps the
 * detailed sentence.
 */
describe('the share toast', () => {
  it('the App uses the short key, without a title', () => {
    const app = read('App.vue')
    expect(app).toContain("$t('addLink.addedShort')")
    expect(app).not.toContain("$t('addLink.added',")
  })

  it('the AddLink page keeps the detailed sentence', () => {
    const page = read('pages', 'AddLinkPage.vue')
    expect(page).toContain("$t('addLink.added',")
  })

  it('both keys exist in both languages, and the short one really is short', () => {
    for (const locale of [de, en]) {
      expect(locale.addLink.added).toContain('{title}')
      expect(locale.addLink.addedShort).toBeTruthy()
      expect(locale.addLink.addedShort).not.toContain('{title}')
      expect(locale.addLink.addedShort.length).toBeLessThan(30)
    }
  })
})
