import { reactive } from 'vue'
import { storageGet, storageSet, storageRemove } from '../utils/storage.js'
import { fetchAndParseFeed, normalizeArticle, discoverFeedUrl } from '../utils/feedParser.js'
import { fetchLinkMetadata } from '../utils/linkParser.js'
import { fetchArticleContent } from '../utils/articleParser.js'
import { parseBookmarks, exportBookmarks } from '../utils/bookmarks.js'
import {
  resolveReadingPrefs,
  DEFAULT_READING_FONT,
  DEFAULT_READING_FONT_SCALE,
  DEFAULT_READING_WIDTH,
} from '../utils/fonts.js'
import { DEFAULT_AI_SETTINGS, isAiConfigured, quellFilterArticles } from '../utils/ai.js'
import {
  DEFAULT_WEBDAV_SETTINGS,
  createEmptyTombstones,
  normalizeTombstones,
  addTombstone,
  syncWithWebdav,
} from '../utils/sync.js'
import { DEFAULT_PAYWALL_SETTINGS } from '../utils/paywall.js'
import { DEFAULT_KARAKEEP_SETTINGS, syncWithKarakeep, deleteFromKarakeep } from '../utils/karakeep.js'
import { DEFAULT_LINKWARDEN_SETTINGS, syncWithLinkwarden, deleteFromLinkwarden } from '../utils/linkwarden.js'
import { DEFAULT_INSTAPAPER_SETTINGS, syncWithInstapaper, deleteFromInstapaper } from '../utils/instapaper.js'
import { clearDomainConfigCache, getDefaultConfigBaseUrl, normalizeConfigBaseUrl } from '../utils/domainConfig.js'
import { getFaviconUrl } from '../utils/favicon.js'
import { applyTheme, resolveThemeChoice } from '../utils/theme.js'

const FEEDS_KEY = 'quell:feeds'
const ARTICLES_KEY = 'quell:articles'
const SETTINGS_KEY = 'quell:settings'
const TOMBSTONES_KEY = 'quell:tombstones'
const LAST_FETCH_KEY = 'quell:lastFetch'
const REFRESH_INTERVAL = 5 * 60 * 1000 // 5 minutes

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export const store = reactive({
  feeds: [],
  articles: [],
  // Deletions need graves. Without them a feed deleted on the phone would simply
  // come back from the tablet on the next sync.
  tombstones: createEmptyTombstones(),
  settings: {
    language: navigator.language?.startsWith('de') ? 'de' : 'en',
    theme: 'system',
    readingFont: DEFAULT_READING_FONT,
    // A relative scale (1 = normal), not pixels — so it follows the device's own
    // text-size setting. Old px values in storage are migrated by resolveReadingPrefs.
    readingFontSize: DEFAULT_READING_FONT_SCALE,
    readingWidth: DEFAULT_READING_WIDTH,
    // Whether the Feed tab also shows quelled (AI-suppressed) articles, dimmed.
    showQuelled: false,
    domainConfigBaseUrl: getDefaultConfigBaseUrl(),
    ai: { ...DEFAULT_AI_SETTINGS },
    webdav: { ...DEFAULT_WEBDAV_SETTINGS },
    karakeep: { ...DEFAULT_KARAKEEP_SETTINGS },
    linkwarden: { ...DEFAULT_LINKWARDEN_SETTINGS },
    instapaper: { ...DEFAULT_INSTAPAPER_SETTINGS },
    paywall: { ...DEFAULT_PAYWALL_SETTINGS },
  },
  loading: false,
  refreshing: false,
  syncing: false,

  // ── Init ──────────────────────────────────────────────────
  async init() {
    await this.initLocal()
    await this.initRemote()
  },
  /**
   * Everything the first painted frame needs — and nothing that needs the network.
   * The split exists for the splash screen: it stays up exactly until this is done,
   * so the user never sees the white, still-empty WebView, but is not held hostage
   * to a feed refresh either.
   */
  async initLocal() {
    await Promise.all([this.loadFeeds(), this.loadArticles(), this.loadSettings(), this.loadTombstones()])
    this.applyTheme()
  },
  async initRemote() {
    // Sync before refreshing, so a feed added on another device is already here when
    // the refresh runs — otherwise its articles would only arrive one start later.
    if (this.settings.webdav.enabled) {
      try {
        await this.syncWithWebdav()
      } catch (e) {
        // A dead server must never block startup. The Sync screen reports it properly.
        console.warn('[store] startup sync failed:', e.message)
      }
    }

    await this.refreshIfStale()
  },

  // ── Settings ──────────────────────────────────────────────
  async loadSettings() {
    const saved = await storageGet(SETTINGS_KEY)
    if (!saved) return

    // `ai` and `webdav` are nested, so a plain assign would replace the whole object —
    // a settings blob written by an older version would arrive missing keys.
    const { ai, webdav, karakeep, linkwarden, instapaper, paywall, ...flat } = saved
    Object.assign(this.settings, flat)
    this.settings.ai = { ...DEFAULT_AI_SETTINGS, ...(ai || {}) }
    this.settings.webdav = { ...DEFAULT_WEBDAV_SETTINGS, ...(webdav || {}) }
    this.settings.karakeep = { ...DEFAULT_KARAKEEP_SETTINGS, ...(karakeep || {}) }
    this.settings.linkwarden = { ...DEFAULT_LINKWARDEN_SETTINGS, ...(linkwarden || {}) }
    this.settings.instapaper = { ...DEFAULT_INSTAPAPER_SETTINGS, ...(instapaper || {}) }
    this.settings.paywall = { ...DEFAULT_PAYWALL_SETTINGS, ...(paywall || {}) }
  },
  async loadTombstones() {
    this.tombstones = normalizeTombstones(await storageGet(TOMBSTONES_KEY))
  },
  async saveTombstones() {
    await storageSet(TOMBSTONES_KEY, this.tombstones)
  },
  async setAiSettings(patch) {
    this.settings.ai = { ...this.settings.ai, ...patch }
    await this.saveSettings()
  },
  async setWebdavSettings(patch) {
    this.settings.webdav = { ...this.settings.webdav, ...patch }
    await this.saveSettings()
  },
  async setKarakeepSettings(patch) {
    this.settings.karakeep = { ...this.settings.karakeep, ...patch }
    await this.saveSettings()
  },
  async setLinkwardenSettings(patch) {
    this.settings.linkwarden = { ...this.settings.linkwarden, ...patch }
    await this.saveSettings()
  },
  async setInstapaperSettings(patch) {
    this.settings.instapaper = { ...this.settings.instapaper, ...patch }
    await this.saveSettings()
  },
  async setPaywallSites(sites) {
    this.settings.paywall = { ...this.settings.paywall, sites }
    await this.saveSettings()
  },
  async setShowQuelled(value) {
    this.settings.showQuelled = Boolean(value)
    await this.saveSettings()
  },

  // ── Sync ──────────────────────────────────────────────────
  async syncWithWebdav() {
    if (this.syncing) return { pushed: 0, pulled: 0 }
    this.syncing = true

    try {
      const result = await syncWithWebdav(
        { feeds: this.feeds, articles: this.articles, tombstones: this.tombstones },
        this.settings.webdav,
      )

      // Only touch local storage when the merge actually produced something new —
      // a read-only device should not rewrite everything on every sync.
      if (result.changed) {
        this.feeds = result.feeds
        this.articles = result.articles
        this.tombstones = result.tombstones
        await Promise.all([this.saveFeeds(), this.saveArticles(), this.saveTombstones()])
      }

      await this.setWebdavSettings({ lastSync: new Date().toISOString() })

      return { pushed: result.pushed, pulled: result.pulled }
    } finally {
      this.syncing = false
    }
  },

  // Both take the FULL article list, not just the saved ones: an article that also lives
  // in a feed would otherwise come back as a second, feed-less copy.
  async syncWithKarakeep() {
    if (this.syncing) return { pushed: 0, pulled: 0 }
    this.syncing = true

    try {
      const { articles, pushed, pulled } = await syncWithKarakeep(this.articles, this.settings.karakeep)
      this.articles = articles
      await this.saveArticles()
      await this.setKarakeepSettings({ lastSync: new Date().toISOString() })
      return { pushed, pulled }
    } finally {
      this.syncing = false
    }
  },

  async syncWithLinkwarden() {
    if (this.syncing) return { pushed: 0, pulled: 0 }
    this.syncing = true

    try {
      const { articles, pushed, pulled } = await syncWithLinkwarden(this.articles, this.settings.linkwarden)
      this.articles = articles
      await this.saveArticles()
      await this.setLinkwardenSettings({ lastSync: new Date().toISOString() })
      return { pushed, pulled }
    } finally {
      this.syncing = false
    }
  },
  async syncWithInstapaper() {
    if (this.syncing) return { pushed: 0, pulled: 0 }
    this.syncing = true

    try {
      const { articles, pushed, pulled } = await syncWithInstapaper(this.articles, this.settings.instapaper)
      this.articles = articles
      await this.saveArticles()
      await this.setInstapaperSettings({ lastSync: new Date().toISOString() })
      return { pushed, pulled }
    } finally {
      this.syncing = false
    }
  },
  async saveSettings() {
    await storageSet(SETTINGS_KEY, this.settings)
  },
  async setTheme(theme) {
    this.settings.theme = theme || 'system'
    this.applyTheme()
    await this.saveSettings()
  },
  async setDomainConfigBaseUrl(baseUrl) {
    this.settings.domainConfigBaseUrl = normalizeConfigBaseUrl(baseUrl)
    await this.saveSettings()
  },
  async setReadingFont(font) {
    this.settings.readingFont = resolveReadingPrefs({ font }).font
    await this.saveSettings()
  },
  async setReadingFontSize(size) {
    this.settings.readingFontSize = resolveReadingPrefs({ fontSize: size }).fontSize
    await this.saveSettings()
  },
  async setReadingWidth(width) {
    this.settings.readingWidth = resolveReadingPrefs({ width }).width
    await this.saveSettings()
  },
  applyTheme() {
    return applyTheme(this.settings.theme)
  },

  // ── Feeds ─────────────────────────────────────────────────
  async loadFeeds() {
    this.feeds = (await storageGet(FEEDS_KEY)) || []
  },
  async saveFeeds() {
    await storageSet(FEEDS_KEY, this.feeds)
  },
  async addFeed(url) {
    console.log('[store] addFeed:', url)
    const feedUrl = await discoverFeedUrl(url)
    console.log('[store] discovered feed URL:', feedUrl)
    if (!feedUrl) throw new Error('not_found')
    if (this.feeds.find(f => f.url === feedUrl)) throw new Error('already_added')

    console.log('[store] fetching feed:', feedUrl)
    const parsed = await fetchAndParseFeed(feedUrl)
    const feed = {
      id: crypto.randomUUID(),
      url: feedUrl,
      title: parsed.title || new URL(feedUrl).hostname,
      // The channel's declared language — decides whether the reading view offers
      // the translate button prominently for this feed's articles. Local-only.
      language: parsed.language || '',
      favicon: getFaviconUrl(feedUrl),
      lastFetched: new Date().toISOString(),
      // Lets a re-added feed beat its own old tombstone. `lastFetched` cannot do that
      // job — a feed polled every 5 minutes would climb out of its grave every time.
      updatedAt: new Date().toISOString(),
    }
    this.feeds.push(feed)
    this.feeds.sort((a, b) => a.title.localeCompare(b.title))
    await this.saveFeeds()

    const newArticles = parsed.items.map(item => normalizeArticle(item, feed.id))
    this._mergeArticles(newArticles)
    await this.saveArticles()
    return feed
  },
  /**
   * The per-feed AI filter wish. Blank means "filter off". Stamping `updatedAt` is
   * what lets the WebDAV sync carry the prompt to other devices — without it the
   * merge has nothing to compare and the change would lose to any older copy.
   */
  async setFeedFilterPrompt(feedId, filterPrompt) {
    const feed = this.getFeedById(feedId)
    if (!feed) return

    const value = String(filterPrompt || '')
    if ((feed.filterPrompt || '') === value) return

    feed.filterPrompt = value
    feed.updatedAt = new Date().toISOString()
    await this.saveFeeds()
  },
  async removeFeed(feedId) {
    const feed = this.getFeedById(feedId)
    if (!feed) return

    const orphaned = this.articles.filter(a => a.feedId === feedId)

    // Saved and archived articles OUTLIVE the unsubscribe: a bookmark is a bookmark, and
    // "archived" means keep forever. They are detached into links (feedId null) and get
    // no tombstone; only the plain feed items go, with graves. The WebDAV merge applies
    // the same rule when a feed tombstone arrives from another device.
    const doomed = []
    for (const article of orphaned) {
      if (article.isSaved || article.isArchived) article.feedId = null
      else doomed.push(article)
    }

    this.feeds = this.feeds.filter(f => f.id !== feedId)
    this.articles = this.articles.filter(a => a.feedId !== feedId)

    // addTombstone returns a NEW object and does not mutate — the return value is
    // the whole point.
    this.tombstones = addTombstone(this.tombstones, 'feeds', feed.url)
    for (const article of doomed) {
      this.tombstones = addTombstone(this.tombstones, 'articles', article.url)
    }

    await Promise.all([this.saveFeeds(), this.saveArticles(), this.saveTombstones()])
  },

  // ── Links (standalone articles, no feed behind them) ───────
  async addLink(url) {
    console.log('[store] addLink:', url)

    let metadata
    try {
      metadata = await fetchLinkMetadata(url)
    } catch (e) {
      if (e instanceof TypeError || e.message === 'empty_url') throw new Error('invalid_url')
      throw e
    }

    if (this.articles.some(a => a.url === metadata.url)) throw new Error('already_added')

    const article = {
      id: crypto.randomUUID(),
      feedId: null,
      source: metadata.source,
      url: metadata.url,
      title: metadata.title,
      description: metadata.description,
      image: metadata.image,
      isRead: false,
      isSaved: true,
      publishedAt: metadata.publishedAt || new Date().toISOString(),
      cachedHtml: null,
      updatedAt: new Date().toISOString(),
    }

    this.articles.push(article)
    this.articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    await this.saveArticles()
    // Not awaited: a share hands back to the previous app immediately; the download
    // finishes in the background (or, failing that, on first open).
    this.prefetchArticleHtml(article.id)
    return article
  },

  /**
   * Imports a Netscape bookmark file. Same format floccus writes, so a WebDAV
   * round-trip through a browser's bookmarks works without a converter.
   * Union by URL — an import never removes anything.
   *
   * `archive: true` files the entries straight into the archive (isArchived implies
   * isSaved — the store's invariant, an archived article is a kept one).
   */
  async importBookmarks(html, options = {}) {
    const archive = Boolean(options.archive)
    const entries = parseBookmarks(html)
    const known = new Set(this.articles.map(a => a.url))
    let imported = 0

    for (const entry of entries) {
      if (known.has(entry.url)) continue

      this.articles.push({
        id: crypto.randomUUID(),
        feedId: null,
        source: hostnameOf(entry.url),
        url: entry.url,
        title: entry.title,
        description: entry.description || '',
        image: null,
        isRead: false,
        isSaved: true,
        isArchived: archive,
        publishedAt: entry.publishedAt || new Date().toISOString(),
        cachedHtml: null,
        updatedAt: new Date().toISOString(),
      })
      known.add(entry.url)
      imported++
    }

    if (imported > 0) {
      this.articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      await this.saveArticles()
    }

    return { imported, skipped: entries.length - imported }
  },

  // ── Articles ──────────────────────────────────────────────
  async loadArticles() {
    this.articles = (await storageGet(ARTICLES_KEY)) || []
  },
  async saveArticles() {
    await storageSet(ARTICLES_KEY, this.articles)
  },
  _mergeArticles(incoming) {
    const existingUrls = new Set(this.articles.map(a => a.url))
    for (const a of incoming) {
      if (!existingUrls.has(a.url)) {
        this.articles.push(a)
        existingUrls.add(a.url)
      }
    }
    this.articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
  },
  /**
   * Every user action on an article stamps it. The sync merge resolves conflicts
   * field-by-field with last-write-wins, and without this stamp there is nothing to
   * compare: "mark as unread" on the phone would silently lose against the tablet's
   * older "read", because the fallback rule is that `true` wins.
   */
  _touch(article) {
    article.updatedAt = new Date().toISOString()
  },
  async markRead(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (a && !a.isRead) {
      a.isRead = true
      this._touch(a)
      await this.saveArticles()
    }
  },
  async markUnread(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (a) {
      a.isRead = false
      this._touch(a)
      await this.saveArticles()
    }
  },
  /**
   * `options.html`: the caller already holds the article's extracted HTML (the reading
   * view does) — it becomes the offline copy directly, no second fetch.
   */
  async toggleSave(articleId, options = {}) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a) return

    // A link has no feed to re-supply it, so unsaving one has to mean deleting it —
    // otherwise it would linger in the feed with no way to ever get rid of it.
    if (a.isSaved && !a.feedId) {
      await this.removeArticle(articleId)
      return
    }

    a.isSaved = !a.isSaved
    if (!a.isSaved) {
      // Unsaving takes the article out of the archive too: an archived article is by
      // definition a saved one, and cachedHtml belongs only to saved articles.
      a.isArchived = false
      a.cachedHtml = null
    } else if (options.html) {
      a.cachedHtml = options.html
    }
    this._touch(a)
    await this.saveArticles()

    // Saving promises offline readability — so the download starts at the save, not
    // at the first open. Deliberately not awaited: the tap must not wait on a page.
    if (a.isSaved && !a.cachedHtml) this.prefetchArticleHtml(articleId)
  },
  /**
   * Archive = "done reading, keep forever" (Instapaper/Pocket semantics). Archiving
   * implies saving: only `isSaved` articles keep their cachedHtml and survive any
   * clean-up, and an archived article must stay offline-readable for good. NOTHING in
   * the store may ever prune an article with `isSaved` or `isArchived` set — there is
   * no article pruning today, and whoever adds one must honour that invariant.
   */
  async archiveArticle(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a || a.isArchived) return
    a.isArchived = true
    a.isSaved = true
    this._touch(a)
    await this.saveArticles()
  },
  /** Restore from the archive — the article moves back to the saved list. */
  async unarchiveArticle(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a || !a.isArchived) return
    a.isArchived = false
    this._touch(a)
    await this.saveArticles()
  },
  /**
   * "Unquell": the user overrules the AI filter for this article. Stamped like
   * every other user action, so the decision wins on other devices too.
   */
  async unquellArticle(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (a && a.isQuelled) {
      a.isQuelled = false
      this._touch(a)
      await this.saveArticles()
    }
  },
  async removeArticle(articleId) {
    const article = this.getArticleById(articleId)
    if (!article) return

    this.articles = this.articles.filter(a => a.id !== articleId)
    this.tombstones = addTombstone(this.tombstones, 'articles', article.url)

    await Promise.all([this.saveArticles(), this.saveTombstones()])
    await this._propagateDeletion(article.url)
  },

  /**
   * KaraKeep, Linkwarden and Instapaper have no tombstones — the server holds the truth. Unless the
   * deletion is pushed through, the article simply comes back on the next pull.
   *
   * Best-effort on purpose: a server that is down must never block a local deletion. The
   * user deleted it; that has to stick regardless.
   */
  async _propagateDeletion(url) {
    if (this.settings.karakeep.enabled) {
      try {
        await deleteFromKarakeep(url, this.settings.karakeep)
      } catch (e) {
        console.warn('[store] KaraKeep delete failed:', e.message)
      }
    }
    if (this.settings.linkwarden.enabled) {
      try {
        await deleteFromLinkwarden(url, this.settings.linkwarden)
      } catch (e) {
        console.warn('[store] Linkwarden delete failed:', e.message)
      }
    }
    if (this.settings.instapaper.enabled) {
      try {
        await deleteFromInstapaper(url, this.settings.instapaper)
      } catch (e) {
        console.warn('[store] Instapaper delete failed:', e.message)
      }
    }
  },
  // Kept with the article: a summary costs the user's own API credit, so it is
  // generated once and then belongs to the article, not to the view.
  async setSummary(articleId, summary) {
    const a = this.articles.find(a => a.id === articleId)
    if (a) {
      a.summary = summary
      this._touch(a)
      await this.saveArticles()
    }
  },
  async cacheHtml(articleId, html) {
    const a = this.articles.find(a => a.id === articleId)
    if (a) {
      a.cachedHtml = html
      await this.saveArticles()
    }
  },
  /**
   * Downloads a saved article's page in the background so it is offline-readable the
   * moment it lands on the reading list. Best-effort by contract: offline, paywall,
   * dead page — none of that is an error, the first open in the reading view caches
   * exactly like before. Everything is re-checked after the fetch, because the user
   * may have unsaved (or opened and thereby cached) the article in the meantime.
   */
  async prefetchArticleHtml(articleId) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a || !a.isSaved || a.cachedHtml || !a.url) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    try {
      const { html, language } = await fetchArticleContent(a.url, this.settings.domainConfigBaseUrl, {
        feedFallback: { title: a.title, description: a.description, url: a.url },
      })

      const current = this.articles.find(x => x.id === articleId)
      if (!current || !current.isSaved || current.cachedHtml) return
      current.cachedHtml = html
      // The page declared its language along the way — keep it, it decides where the
      // translate button lives. Local-only, so no _touch (see setArticleLanguage).
      if (language && !current.language) current.language = language
      await this.saveArticles()
    } catch (e) {
      console.warn('[store] prefetch failed:', e.message)
    }
  },
  /**
   * A finished translation also costs the user's own API credit, so it is kept with
   * the article. Like cachedHtml it is LOCAL-ONLY — sync.js never writes it out
   * (article HTML in the sync file would multiply its size) — and like the summary
   * it survives leaving and reopening the article. No _touch: a purely local field
   * must not bump the article in the sync merge.
   */
  async setTranslation(articleId, translation) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a) return
    a.translation = translation || null // { html, title, language }
    await this.saveArticles()
  },
  /** The language the article's page declared for itself. Local-only, like above. */
  async setArticleLanguage(articleId, language) {
    const a = this.articles.find(a => a.id === articleId)
    if (!a || !language || a.language === language) return
    a.language = language
    await this.saveArticles()
  },
  async clearCaches() {
    let clearedArticleCount = 0
    for (const article of this.articles) {
      if (article.cachedHtml || article.translation) {
        article.cachedHtml = null
        // Same nature as cachedHtml: big, local, reproducible (it costs API credit
        // to reproduce, but "clear caches" is the user asking for exactly that).
        article.translation = null
        clearedArticleCount++
      }
    }

    const clearedDomainConfigCount = await clearDomainConfigCache()
    await storageRemove(LAST_FETCH_KEY)
    await this.saveArticles()

    return {
      clearedArticleCount,
      clearedDomainConfigCount,
    }
  },

  // ── Refresh ───────────────────────────────────────────────
  async refreshIfStale() {
    const lastFetch = await storageGet(LAST_FETCH_KEY)
    if (lastFetch && Date.now() - new Date(lastFetch).getTime() < REFRESH_INTERVAL) return
    await this.refreshAll()
  },
  async refreshAll() {
    if (this.refreshing || this.feeds.length === 0) return
    this.refreshing = true
    try {
      await Promise.allSettled(this.feeds.map(f => this._refreshFeed(f)))
      await storageSet(LAST_FETCH_KEY, new Date().toISOString())
      await this.saveArticles()
      await this.saveFeeds()
    } finally {
      this.refreshing = false
    }
  },
  async _refreshFeed(feed) {
    try {
      const parsed = await fetchAndParseFeed(feed.url)
      feed.lastFetched = new Date().toISOString()
      if (parsed.title) feed.title = parsed.title
      if (parsed.language) feed.language = parsed.language
      const newArticles = parsed.items.map(item => normalizeArticle(item, feed.id))
      // BEFORE the merge, deliberately: once merged, an item's URL is "known" and
      // will never be rated again — rating costs the user's own API credit.
      await this._applyQuellFilter(feed, newArticles)
      this._mergeArticles(newArticles)
    } catch (e) {
      console.error(`[store] _refreshFeed failed for ${feed.url}:`, e)
      throw e
    }
  },

  /**
   * Runs the feed's AI filter over the items of this refresh that are actually NEW
   * (URL not yet in the store — the exact criterion _mergeArticles uses to accept
   * them). Matching items get `isQuelled = true` and are then merged like any
   * other: quelling hides, it never deletes.
   *
   * Fail-open by contract: no prompt, no key, offline, timeout, provider error,
   * unparseable answer — each of these filters nothing and lets the refresh finish
   * normally. A background refresh must never fail, hang or toast because of the
   * filter; a console.warn is all a broken provider gets.
   */
  async _applyQuellFilter(feed, incoming) {
    const prompt = String(feed.filterPrompt || '').trim()
    if (!prompt) return
    if (!isAiConfigured(this.settings.ai)) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return

    const known = new Set(this.articles.map(a => a.url))
    const fresh = []
    for (const article of incoming) {
      if (!known.has(article.url)) {
        fresh.push(article)
        // A feed page can carry the same URL twice — rate it once, like the merge keeps it once.
        known.add(article.url)
      }
    }
    if (fresh.length === 0) return

    try {
      const indices = await quellFilterArticles(prompt, fresh, this.settings.ai)
      for (const index of indices) {
        if (fresh[index]) fresh[index].isQuelled = true
      }
    } catch (e) {
      console.warn(`[store] quell filter skipped for ${feed.url}:`, e.message)
    }
  },

  // ── Computed helpers (used as methods for Options API) ────
  getFeedById(id) {
    return this.feeds.find(f => f.id === id)
  },
  getArticleById(id) {
    return this.articles.find(a => a.id === id)
  },
  getQuelledCount(feedId) {
    return this.articles.filter(a => a.feedId === feedId && a.isQuelled).length
  },
  getSourceLabel(article) {
    if (!article) return ''
    if (article.feedId) return this.getFeedById(article.feedId)?.title || ''
    if (article.source) return article.source
    try {
      return new URL(article.url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  },
  /**
   * The Feed tab shows what came out of a subscribed feed — and nothing else.
   *
   * This used to return `this.articles`, the whole list. But a link (feedId === null) was
   * never in a feed: it was typed in by hand, shared into the app from the Android share
   * sheet, imported from a bookmark file, or pulled down from KaraKeep/Linkwarden. All of
   * those landed in the Feed tab as well, so a saved link appeared twice — once under
   * Saved, where it belongs, and once in a "feed" the user had never subscribed to.
   *
   * A saved *feed* article deliberately stays here: saving an article does not take it
   * out of the feed it came from. Saving is a bookmark, not a move.
   *
   * Quelled articles (suppressed by the per-feed AI filter) are stored but hidden —
   * unless the user flips `showQuelled`, which shows them dimmed instead of hiding
   * them. Hidden means filtered here, not deleted: unquelling is always possible.
   */
  get feedArticles() {
    return this.articles.filter(a => Boolean(a.feedId) && (this.settings.showQuelled || !a.isQuelled))
  },
  // The Saved tab's first segment: saved, but not yet filed away into the archive.
  get savedArticles() {
    return this.articles.filter(a => a.isSaved && !a.isArchived)
  },
  get archivedArticles() {
    return this.articles.filter(a => Boolean(a.isArchived))
  },
  get resolvedTheme() {
    return resolveThemeChoice(this.settings.theme)
  },
  // Always validated, so a corrupted stored value can never reach the reading view.
  get readingPrefs() {
    return resolveReadingPrefs({
      font: this.settings.readingFont,
      fontSize: this.settings.readingFontSize,
      width: this.settings.readingWidth,
    })
  },
  get linkArticles() {
    return this.articles.filter(a => !a.feedId)
  },
  get aiReady() {
    return isAiConfigured(this.settings.ai)
  },
  // Reading list and archive export as the same Netscape format they import from —
  // one file per shelf, so a round trip restores each article onto its own shelf.
  exportReadingList() {
    return exportBookmarks(this.savedArticles, { folder: 'Quell' })
  },
  exportArchive() {
    return exportBookmarks(this.archivedArticles, { folder: 'Quell Archive' })
  },
})
