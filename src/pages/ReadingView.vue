<template>
  <f7-page
    name="article"
    :ptr="!isOffline"
    hide-navbar-on-scroll
    @page:beforein="onPageIn"
    @page:beforeout="onPageOut"
    @ptr:refresh="onPullRefresh"
  >
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <!-- displayedTitle, not article.title: a translated article announces itself
           in the navbar too. -->
      <f7-nav-title>{{ article ? displayedTitle : '' }}</f7-nav-title>
      <!-- Read aloud · translate · archive · share · more — the everyday actions stay
           in reach. Everything rarer (save/unsave, copy, reload, mark unread, open in
           browser) lives in the overflow menu. -->
      <f7-nav-right>
        <f7-link
          v-if="article && speechAvailable"
          class="nav-icon-link"
          @click="toggleSpeechPlayer"
        >
          <AppIcon
            name="volume-high-outline"
            :class="speechActive && 'color-accent'"
            :label="speechActive ? $t('article.player.stop') : $t('article.speak')"
          />
        </f7-link>
        <!-- Prominent only when the article does not (verifiably) speak the app
             language — a German article in a German UI keeps the slot free and the
             action moves into the More menu. -->
        <f7-link v-if="article && translateInToolbar" class="nav-icon-link" @click="toggleTranslation">
          <f7-preloader v-if="translating" size="20"></f7-preloader>
          <AppIcon
            v-else
            name="language-outline"
            :class="showTranslation && 'color-accent'"
            :label="$t('article.translate')"
          />
        </f7-link>
        <!-- The lifecycle button: save -> archive -> restore, one verb per stage
             (src/utils/articleLifecycle.js). An unsaved article offers SAVE here —
             showing "archive" before the reader ever kept the article was a bug. -->
        <f7-link v-if="article" class="nav-icon-link" @click="onPrimaryAction">
          <AppIcon :name="primaryActionIcon" :label="primaryActionLabel" />
        </f7-link>
        <f7-link v-if="article" class="nav-icon-link" @click="shareArticle">
          <AppIcon name="share-outline" :label="$t('article.share')" />
        </f7-link>
        <f7-link v-if="article" class="nav-icon-link" @click="openMoreMenu">
          <AppIcon name="ellipsis-horizontal-outline" :label="$t('article.more')" />
        </f7-link>
      </f7-nav-right>
    </f7-navbar>

    <div v-if="loading" class="empty-state">
      <f7-preloader></f7-preloader>
      <p class="empty-state__text">{{ loadingLabel }}</p>
      <p class="empty-state__text empty-state__text--subtle">{{ loadingHint }}</p>
    </div>

    <div v-else-if="error" class="empty-state">
      <div class="empty-state__icon">
        <AppIcon name="alert-circle-outline" size="xl" />
      </div>
      <p class="empty-state__text">{{ $t('article.loadError') }}</p>
      <f7-button :href="article && article.url" external>
        {{ $t('article.openInBrowser') }}
      </f7-button>
    </div>

    <template v-else-if="iframeDoc">
      <!-- Above the article, because a TL;DR is what you read to decide whether to
           read at all. Collapsed until asked for — nobody's key gets spent by accident. -->
      <div v-if="aiReady" class="summary-card">
        <div v-if="summary" class="summary-card__body">
          <div class="summary-card__label">
            <AppIcon name="sparkles-outline" size="inline" />
            {{ $t('article.summary') }}
          </div>
          <!-- The reader's chosen article typeface — the TL;DR is article, not UI. -->
          <p class="summary-card__text" :style="summaryTextStyle">{{ summary }}</p>
        </div>

        <f7-button v-else-if="!summarizing" class="summary-card__action" @click="summarize">
          <AppIcon name="sparkles-outline" size="inline" />
          {{ $t('article.summarize') }}
        </f7-button>

        <div v-else class="summary-card__body summary-card__body--loading">
          <f7-preloader size="20"></f7-preloader>
          <span>{{ $t('article.summarizing') }}</span>
        </div>
      </div>

      <div v-if="translationNote" class="summary-card summary-card--note">
        {{ translationNote }}
      </div>

      <iframe
        class="reading-iframe"
        sandbox="allow-same-origin"
        :srcdoc="iframeDoc"
        :style="{ height: iframeHeight }"
        @load="onIframeLoad"
      ></iframe>
    </template>

    <!-- A player, not a navbar icon: play/pause, stop, paragraph back/forward and
         where we are. f7-page hoists a toolbar out of the page content by itself, so
         the article keeps scrolling free underneath it. -->
    <f7-toolbar v-if="speechActive" bottom class="speech-player">
      <f7-link
        class="speech-player__button"
        :class="speechIndex <= 0 && 'disabled'"
        @click="speechPrevious"
      >
        <AppIcon name="play-skip-back" :label="$t('article.player.previous')" />
      </f7-link>

      <f7-link class="speech-player__button speech-player__button--main" @click="togglePlayback">
        <AppIcon
          :name="speaking ? 'pause' : 'play'"
          :label="speaking ? $t('article.player.pause') : (speechPaused ? $t('article.player.resume') : $t('article.player.play'))"
        />
      </f7-link>

      <f7-link class="speech-player__button" @click="speechNext">
        <AppIcon name="play-skip-forward" :label="$t('article.player.next')" />
      </f7-link>

      <div class="speech-player__status">
        <span class="speech-player__position">
          {{ $t('article.player.position', { index: speechIndex + 1, total: speechTotal }) }}
        </span>
        <span class="speech-player__track">
          <span class="speech-player__fill" :style="{ width: speechPercent }"></span>
        </span>
      </div>

      <f7-link class="speech-player__button" @click="closeSpeech">
        <AppIcon name="stop" :label="$t('article.player.stop')" />
      </f7-link>
    </f7-toolbar>
  </f7-page>
</template>

<script>
import { f7 } from 'framework7-vue'
import { Clipboard } from '@capacitor/clipboard'
import { shareArticle as shareArticleTo } from '../utils/share.js'
import { extractArticleText, extractArticleMarkdown, collectSpeechBlocks } from '../utils/articleText.js'
import { createSpeechController, isSpeechAvailable } from '../utils/speech.js'
import { createMediaSession } from '../utils/mediaSession.js'
import { fetchArticleContent, buildIframeDoc, FEED_FALLBACK_MARKER_CLASS } from '../utils/articleParser.js'
import { getDomainConfig } from '../utils/domainConfig.js'
import { getHttpTransport } from '../utils/http.js'
import {
  summarizeArticle,
  translateText,
  translateArticleBlocks,
  TRANSLATION_CHUNK_CHARS,
} from '../utils/ai.js'
import { splitHtmlBlocks, planTranslationChunks } from '../utils/htmlBlocks.js'
import { resolveFontStack, injectReadingFonts } from '../utils/fonts.js'
import { sanitizeArticleHtml } from '../utils/sanitize.js'
import { primaryLifecycleAction } from '../utils/articleLifecycle.js'

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
}

/**
 * The container's top-level content nodes, in the same order splitHtmlBlocks counts
 * them: elements plus non-blank text nodes. `children` alone would silently skip a
 * bare text block and shift every index after it.
 */
function topLevelNodes(container) {
  return Array.from(container.childNodes).filter(
    node => node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim())
  )
}

const SPEECH_ERROR_KEYS = {
  unsupported: 'speakUnsupported',
  no_content: 'speakNoContent',
  speech_failed: 'speakFailed',
}

const SPEECH_STYLE_ID = 'q-speech-style'

// Lives here and not in READING_CSS (articleParser.js) because it only exists while
// the player is open. `color-mix` is the real rule; the flat grey in front of it is
// what an older WebView keeps when it drops the line it cannot parse.
const SPEECH_CSS = `
  [data-q-speech] {
    border-radius: 6px;
    transition: background-color 160ms ease, box-shadow 160ms ease;
  }
  body.q-speech-on [data-q-speech] { cursor: pointer; }
  .q-speech-current {
    background: rgba(128, 128, 128, 0.18);
    background: color-mix(in srgb, var(--q-accent, #1d3d8f) 15%, transparent);
    box-shadow: 0 0 0 0.3em rgba(128, 128, 128, 0.18);
    box-shadow: 0 0 0 0.3em color-mix(in srgb, var(--q-accent, #1d3d8f) 15%, transparent);
  }
`

/** Where the highlighted paragraph should come to rest, in px from the top. */
const SCROLL_ANCHOR = 120

// ai.js throws snake_case codes; i18n uses camelCase keys.
const AI_ERROR_KEYS = {
  not_configured: 'notConfigured',
  no_content: 'noContent',
  unauthorized: 'unauthorized',
  insufficient_credits: 'insufficientCredits',
  rate_limited: 'rateLimited',
  server_error: 'serverError',
  request_failed: 'requestFailed',
  network_error: 'networkError',
  aborted: 'aborted',
  empty_response: 'emptyResponse',
}

function resolveLoadingState(article, forceRefresh = false) {
  if (!forceRefresh && article?.isSaved && article?.cachedHtml) return 'cache'
  return getHttpTransport()
}

function buildArticleDebugMeta(article) {
  return {
    articleId: article?.id,
    title: article?.title,
    url: article?.url,
    isSaved: Boolean(article?.isSaved),
    hasCachedHtml: Boolean(article?.cachedHtml),
  }
}

export default {
  name: 'ReadingView',

  props: {
    articleId: {
      type: String,
      default: null,
    },
    f7router: Object,
    f7route: Object,
  },

  data() {
    return {
      loading: true,
      loadingState: 'network',
      error: false,
      isOffline: !navigator.onLine,
      articleHtml: null,
      articleConfig: null,
      iframeDoc: null,
      iframeHeight: '100vh',

      summary: null,
      summarizing: false,

      translatedHtml: null,
      translatedTitle: null,
      showTranslation: false,
      translating: false,
      translationNote: null,
      // What the article's page (or its feed) declared as its language — '' / null
      // means "unknown", which keeps the translate button prominent.
      articleLanguage: null,

      speechAvailable: false,
      speechActive: false,
      speaking: false,
      speechPaused: false,
      speechIndex: 0,
      speechTotal: 0,
    }
  },

  computed: {
    article() {
      return this.articleId ? this.$store.getArticleById(this.articleId) : null
    },
    isLink() {
      return Boolean(this.article) && !this.article.feedId
    },
    primaryAction() {
      return primaryLifecycleAction(this.article)
    },
    primaryActionIcon() {
      return {
        save: 'bookmark-outline',
        archive: 'archive-outline',
        restore: 'arrow-undo-outline',
      }[this.primaryAction]
    },
    primaryActionLabel() {
      return {
        save: this.$t('article.save'),
        archive: this.$t('article.archive'),
        restore: this.$t('article.unarchive'),
      }[this.primaryAction]
    },
    loadingLabel() {
      return this.$t(`article.loadingStates.${this.loadingState}`)
    },
    loadingHint() {
      return this.$t(`article.loadingHints.${this.loadingState}`)
    },
    themeChoice() {
      return this.$store.settings.theme
    },
    aiReady() {
      return this.$store.aiReady
    },
    uiLanguage() {
      return this.$store.settings.language
    },
    feedLanguage() {
      const feed = this.article?.feedId ? this.$store.getFeedById(this.article.feedId) : null
      return feed?.language || ''
    },
    /**
     * Whether translate deserves its own navbar slot. Yes while anything
     * translation-related is active or cached; yes when the article's language is
     * unknown or foreign. Only an article that verifiably speaks the app language
     * sends the action into the More menu.
     */
    translateInToolbar() {
      if (this.translating || this.translatedHtml || this.showTranslation) return true
      const lang = this.articleLanguage || this.feedLanguage
      return !lang || lang !== this.uiLanguage
    },
    // What the iframe actually shows — the translation once it exists and is toggled on.
    displayedHtml() {
      return this.showTranslation && this.translatedHtml ? this.translatedHtml : this.articleHtml
    },
    displayedTitle() {
      return this.showTranslation && this.translatedTitle ? this.translatedTitle : this.article?.title
    },
    readingPrefs() {
      return this.$store.readingPrefs
    },
    // The summary card lives in the app document (outside the iframe), so the
    // reading font has to be applied — and its @font-face injected — here.
    // Font size stays the app's: the card is a compact digest, not body text.
    summaryTextStyle() {
      return {
        fontFamily: resolveFontStack(this.readingPrefs.font),
        fontSize: `calc(1rem * ${this.readingPrefs.sizeFactor || 1})`,
      }
    },
    speechPercent() {
      if (this.speechTotal <= 0) return '0%'
      return `${Math.round(((this.speechIndex + 1) / this.speechTotal) * 100)}%`
    },
  },

  watch: {
    themeChoice() {
      this.rerenderIfLoaded()
    },
    // Font and size are baked into the iframe's srcdoc — reactivity alone
    // does not reach inside, the document has to be rebuilt.
    'readingPrefs.font'() {
      this.rerenderIfLoaded()
    },
    'readingPrefs.fontSize'() {
      this.rerenderIfLoaded()
    },
    'readingPrefs.width'() {
      this.rerenderIfLoaded()
    },
  },

  async mounted() {
    window.addEventListener('online', this.updateOnlineStatus)
    window.addEventListener('offline', this.updateOnlineStatus)

    // The summary card renders in the chosen reading font, and that font's
    // @font-face lives inside the iframe — the app document needs its own copy.
    injectReadingFonts()

    // Not reactive on purpose — they hold a queue and a DOM node list, not state to render.
    this.speechBlocks = []
    this.speechLoaded = false
    this.iframeEl = null
    this.media = null
    // The running (or interrupted) translation: original blocks, the chunk plan and
    // every chunk finished so far. Interruption keeps it; tapping translate resumes
    // at the first missing chunk instead of paying for the done ones again.
    this.translationJob = null
    this.previewedBlocks = 0

    this.speech = createSpeechController({
      onStart: total => {
        this.speechTotal = total
        this.speechIndex = 0
      },
      onProgress: index => {
        this.speechIndex = index
        this.highlightBlock(index)
      },
      onStateChange: ({ speaking, paused }) => {
        this.speaking = speaking
        this.speechPaused = paused
        this.media?.setPlaybackState(speaking ? 'playing' : paused ? 'paused' : 'none')
      },
      onEnd: () => {
        // The player stays: the article is read, but the reader may well want it again.
        this.speechIndex = 0
        this.clearHighlight()
        this.media?.release()
      },
      onError: err => this.showSpeechError(err),
    })
    this.speechAvailable = await isSpeechAvailable()

    if (!this.article) {
      this.error = true
      this.loading = false
      return
    }

    await this.loadArticle()
  },

  beforeUnmount() {
    window.removeEventListener('online', this.updateOnlineStatus)
    window.removeEventListener('offline', this.updateOnlineStatus)
    // Leaving the article must silence it — otherwise the app keeps reading a page
    // that is no longer on screen, and the notification outlives its article.
    this.media?.release()
    this.speech?.stop()
  },

  methods: {
    onPageIn() {
      const tabbar = document.querySelector('.tabbar')
      if (tabbar) f7.toolbar.hide(tabbar, false)
    },
    onPageOut() {
      const tabbar = document.querySelector('.tabbar')
      if (tabbar) f7.toolbar.show(tabbar, false)
    },
    rerenderIfLoaded() {
      if (!this.articleHtml) return
      this.renderIframe()
    },
    renderIframe() {
      // The document the spoken blocks point at is about to be replaced, so whatever
      // is being read belongs to a DOM that will not exist in a moment.
      this.closeSpeech()

      const html = this.displayedHtml
      const usesFeedFallback = html?.includes(FEED_FALLBACK_MARKER_CLASS)

      this.iframeDoc = buildIframeDoc(html, this.article?.image, this.themeChoice, {
        title: this.displayedTitle,
        showFeedImage: this.articleConfig?.presentation?.showFeedImage,
        showArticleTitle: usesFeedFallback ? false : this.articleConfig?.presentation?.showArticleTitle,
        reading: {
          font: this.readingPrefs.font,
          fontSize: this.readingPrefs.fontSize,
          width: this.readingPrefs.width,
        },
      })
    },
    async loadArticle(options = {}) {
      const forceRefresh = Boolean(options.forceRefresh)

      // A reload means the article text changed, so any translation of the old text
      // is stale. The summary survives — it belongs to the article, not the fetch.
      this.summary = this.article.summary || null
      this.translatedHtml = null
      this.translatedTitle = null
      this.showTranslation = false
      this.translationNote = null
      this.translationJob = null
      this.articleLanguage = this.article.language || null

      if (forceRefresh && this.article.translation) {
        // The text is about to change under it — a stale translation must not
        // come back on the next visit.
        await this.$store.setTranslation(this.article.id, null)
      }

      // A translation costs the user's own credit, so a finished one is kept with
      // the article and comes straight back — in the language it was made for.
      const savedTranslation = this.article.translation
      if (!forceRefresh && savedTranslation?.html && savedTranslation.language === this.uiLanguage) {
        this.translatedHtml = savedTranslation.html
        this.translatedTitle = savedTranslation.title || null
        this.showTranslation = true
      }

      await this.$store.markRead(this.article.id)

      this.loading = true
      this.loadingState = resolveLoadingState(this.article, forceRefresh)
      this.error = false

      const startedAt = performance.now()
      const articleMeta = buildArticleDebugMeta(this.article)

      console.info('[ReadingView] loadArticle:start', {
        ...articleMeta,
        forceRefresh,
        loadingState: this.loadingState,
        isOffline: this.isOffline,
      })

      if (!forceRefresh && this.article.isSaved && this.article.cachedHtml) {
        this.articleHtml = this.article.cachedHtml
        const domain = new URL(this.article.url).hostname.replace(/^www\./, '')
        this.articleConfig = await getDomainConfig(domain, this.$store.settings.domainConfigBaseUrl)
        this.renderIframe()
        console.info('[ReadingView] loadArticle:cache-hit', {
          ...articleMeta,
          domain,
          durationMs: Math.round(performance.now() - startedAt),
        })
        this.loading = false
        return
      }

      if (this.isOffline) {
        console.warn('[ReadingView] loadArticle:offline', {
          ...articleMeta,
          forceRefresh,
          loadingState: this.loadingState,
        })
        this.error = true
        this.loading = false
        return
      }

      try {
        console.info('[ReadingView] loadArticle:fetching', {
          ...articleMeta,
          forceRefresh,
          loadingState: this.loadingState,
        })
        const { html, config, language } = await fetchArticleContent(this.article.url, this.$store.settings.domainConfigBaseUrl, {
          forceConfigRefresh: forceRefresh,
          feedFallback: {
            title: this.article.title,
            description: this.article.description,
            url: this.article.url,
          },
        })
        this.articleHtml = html
        this.articleConfig = config
        if (language) {
          // The page said what it speaks — remember it, so the next visit (and the
          // cache-hit path) can place the translate button without a fetch.
          this.articleLanguage = language
          this.$store.setArticleLanguage(this.article.id, language)
        }
        this.renderIframe()
        if (this.article.isSaved) {
          await this.$store.cacheHtml(this.article.id, html)
          console.info('[ReadingView] loadArticle:cached', {
            ...articleMeta,
            htmlLength: html.length,
          })
        }
        console.info('[ReadingView] loadArticle:success', {
          ...articleMeta,
          loadingState: this.loadingState,
          htmlLength: html.length,
          hasDomainConfig: Boolean(config),
          durationMs: Math.round(performance.now() - startedAt),
        })
      } catch (error) {
        console.error('[ReadingView] loadArticle:error', {
          ...articleMeta,
          loadingState: this.loadingState,
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : error,
        })
        this.error = true
      } finally {
        this.loading = false
      }
    },
    async reloadArticle() {
      if (this.isOffline) {
        f7.toast.show({ text: this.$t('refresh.offline'), closeTimeout: 2000 })
        return
      }

      await this.loadArticle({ forceRefresh: true })

      if (!this.error) {
        f7.toast.show({ text: this.$t('article.updated'), closeTimeout: 2000 })
      }
    },
    // Reloads THIS article only (fresh fetch of its page) — it never touches the
    // feed. The toast says so; it used to borrow the feed's wording.
    async onPullRefresh(done) {
      try {
        if (this.isOffline) {
          f7.toast.show({ text: this.$t('refresh.offline'), closeTimeout: 2000 })
          return
        }

        await this.loadArticle({ forceRefresh: true })
        if (!this.error) {
          f7.toast.show({ text: this.$t('article.updated'), closeTimeout: 2000 })
        }
      } finally {
        done()
      }
    },
    async toggleSave() {
      const articleId = this.article.id

      // For a link this deletes the article, so leave the view before it vanishes.
      if (this.isLink) {
        await this.$store.toggleSave(articleId)
        this.f7router.back()
        return
      }

      // The loaded HTML travels along — it becomes the offline copy right away, and
      // the store then has no reason to re-download what is already on screen.
      await this.$store.toggleSave(articleId, { html: this.articleHtml || undefined })
    },
    openMoreMenu() {
      // Removing from the reading list is destructive from the reader's point of view
      // — it is called what it does and shown in red. An UNSAVED article gets no such
      // entry: the navbar's lifecycle button already offers "save", and there is
      // nothing to remove yet. No cancel row: tapping outside (or the back gesture)
      // closes the sheet, which is the platform's own way.
      const removal = this.isLink
        ? [{ text: this.$t('article.delete'), color: 'red', onClick: () => this.toggleSave() }]
        : this.article.isSaved
          ? [{ text: this.$t('article.removeFromList'), color: 'red', onClick: () => this.toggleSave() }]
          : []

      // When the article already speaks the app language, translate lives here
      // instead of occupying a navbar slot.
      const translate = this.translateInToolbar
        ? []
        : [{
            text: this.showTranslation ? this.$t('article.showOriginal') : this.$t('article.translate'),
            onClick: () => this.toggleTranslation(),
          }]

      f7.actions
        .create({
          buttons: [
            [
              { text: this.$t('article.copy'), onClick: () => this.openCopyMenu() },
              { text: this.$t('article.reload'), onClick: () => this.reloadArticle() },
              { text: this.$t('article.markUnread'), onClick: () => this.markUnread() },
              ...translate,
              { text: this.$t('article.openInBrowser'), onClick: () => window.open(this.article.url, '_blank') },
            ],
            ...(removal.length ? [removal] : []),
          ],
        })
        .open()
    },

    /**
     * Archive from the reading view. Archiving is "done with this, keep it forever", so
     * the loaded HTML is cached first — the article must stay readable offline — and the
     * view closes, like it does for the other "I am done here" action (markUnread).
     * Restoring stays: the reader asked the article back onto the saved shelf.
     */
    async toggleArchive() {
      const articleId = this.article.id

      if (this.article.isArchived) {
        await this.$store.unarchiveArticle(articleId)
        return
      }

      await this.$store.archiveArticle(articleId)
      if (this.articleHtml && !this.article.cachedHtml) {
        await this.$store.cacheHtml(articleId, this.articleHtml)
      }
      this.f7router.back()
    },

    /** The lifecycle button: which verb depends on the stage the article is in. */
    async onPrimaryAction() {
      if (this.primaryAction === 'save') {
        await this.toggleSave()
        return
      }
      await this.toggleArchive()
    },

    // A native action sheet, not a hand-built modal — it is the platform's own
    // "pick one of these" control and needs no design of ours.
    openCopyMenu() {
      f7.actions
        .create({
          buttons: [
            [{ text: this.$t('article.copyTitle'), label: true }],
            [
              { text: this.$t('article.copyPlain'), onClick: () => this.copy('plain') },
              { text: this.$t('article.copyRich'), onClick: () => this.copy('rich') },
              { text: this.$t('article.copyLink'), onClick: () => this.copy('link') },
            ],
          ],
        })
        .open()
    },

    async copy(variant) {
      const html = this.displayedHtml
      const text =
        variant === 'link' ? this.article.url
        : variant === 'rich' ? extractArticleMarkdown(html, { skipCaptions: false, skipImages: false })
        : extractArticleText(html, { skipCaptions: true })

      try {
        await Clipboard.write({ string: text })
        f7.toast.show({ text: this.$t('article.copied'), closeTimeout: 2000 })
      } catch (err) {
        console.error('[ReadingView] copy failed:', err?.message)
        f7.toast.show({ text: this.$t('article.copyFailed'), closeTimeout: 2500 })
      }
    },

    // ── Read aloud ──────────────────────────────────────────────────────────
    // The units come from the *live* iframe DOM, not from a re-parse of the HTML:
    // only then does every spoken paragraph know its node, which is what the
    // highlight, the auto-scroll and "tap a paragraph" all hang off.

    toggleSpeechPlayer() {
      if (this.speechActive) {
        this.closeSpeech()
        return
      }
      this.openSpeech()
    },

    async openSpeech() {
      // The blocks first, the bar second: the player opens knowing how many
      // paragraphs it has, so it never shows "paragraph 1 of 0".
      if (this.buildSpeechBlocks().length === 0) {
        this.showSpeechError(new Error('no_content'))
        return
      }

      this.speechIndex = 0
      this.speechTotal = this.speechBlocks.length
      this.speechActive = true

      await this.speakFrom(0)
    },

    async closeSpeech() {
      this.speechActive = false
      this.speechLoaded = false
      this.speechIndex = 0
      this.speechTotal = 0
      this.speechBlocks = []
      this.clearHighlight()
      this.setSpeechMode(false)
      this.media?.release()
      await this.speech?.stop()
    },

    async togglePlayback() {
      if (this.speaking) {
        await this.speech.pause()
        return
      }
      if (this.speechPaused) {
        // enable() only works from a gesture, and this click is one — the carrier may
        // have been dropped while we were paused.
        await this.enableMediaSession()
        await this.speech.resume()
        return
      }
      await this.speakFrom(this.speechIndex)
    },

    speechNext() {
      this.speech?.next()
    },

    speechPrevious() {
      this.speech?.previous()
    },

    /** Starts, or jumps to, a paragraph — the play button, the tap, the notification. */
    async speakFrom(index) {
      if (!this.speechAvailable) return

      // Must run inside the click that got us here: the silent carrier of the media
      // notification may only be started from a user gesture.
      await this.enableMediaSession()

      // The controller already holds the article — a seek keeps its queue and saves a
      // whole language round trip to the engine.
      if (this.speechLoaded) {
        await this.speech.seekTo(index)
        return
      }

      const units = this.speechBlocks.length > 0 ? this.speechBlocks : this.buildSpeechBlocks()
      if (units.length === 0) {
        this.showSpeechError(new Error('no_content'))
        await this.closeSpeech()
        return
      }

      this.speechLoaded = true
      try {
        // Resolves only when the whole article has been read.
        await this.speech.speak(
          { units: units.map(block => block.text) },
          { language: this.$store.settings.language, startAt: index },
        )
      } catch {
        this.speechLoaded = false // onError has already told the reader
      }
    },

    /**
     * Captions and images stay out — a reader that says "figure 3, a fossil fish,
     * photographed from above" between paragraphs is unlistenable.
     */
    buildSpeechBlocks() {
      const doc = this.iframeEl?.contentDocument
      if (!doc?.body) return []

      const blocks = collectSpeechBlocks(doc.body, { skipCaptions: true })

      // The title is only a block when the iframe actually renders it (the domain
      // config may suppress it) — but it should always be read.
      const title = String(this.displayedTitle || '').trim()
      if (title && !doc.querySelector('.article-title')) {
        blocks.unshift({ element: null, text: title })
      }

      blocks.forEach((block, index) => block.element?.setAttribute('data-q-speech', String(index)))

      this.speechBlocks = blocks
      this.setSpeechMode(blocks.length > 0)
      return blocks
    },

    setSpeechMode(on) {
      const body = this.iframeEl?.contentDocument?.body
      body?.classList.toggle('q-speech-on', Boolean(on))
    },

    highlightBlock(index) {
      this.clearHighlight()

      const element = this.speechBlocks?.[index]?.element
      if (!element) return

      element.classList.add('q-speech-current')
      this.scrollBlockIntoView(element)
    },

    clearHighlight() {
      const doc = this.iframeEl?.contentDocument
      doc?.querySelectorAll('.q-speech-current').forEach(el => el.classList.remove('q-speech-current'))
    },

    /**
     * The iframe is sized to its own content, so its document never scrolls — the f7
     * page does. An element's rect inside the iframe is therefore already in the outer
     * viewport once the iframe's own offset is added.
     */
    scrollBlockIntoView(element) {
      const pageContent = this.$el?.querySelector?.('.page-content')
      if (!pageContent || !this.iframeEl) return

      const top = element.getBoundingClientRect().top + this.iframeEl.getBoundingClientRect().top
      const comfortable = top >= 72 && top <= window.innerHeight * 0.6
      if (comfortable) return // already in sight — do not yank the page around

      pageContent.scrollTo({
        top: Math.max(0, pageContent.scrollTop + top - SCROLL_ANCHOR),
        behavior: 'smooth',
      })
    },

    /**
     * Tapping a paragraph reads on from there — but only while the player is open.
     * Outside it the article is an article: taps select text and follow links, and a
     * stray touch must not start talking.
     */
    onIframeClick(event) {
      if (!this.speechActive) return

      const target = event.target
      if (!target?.closest) return
      if (target.closest('a')) return // a link stays a link
      if (this.iframeEl?.contentDocument?.getSelection?.()?.toString()) return

      const block = target.closest('[data-q-speech]')
      if (!block) return

      const index = Number(block.getAttribute('data-q-speech'))
      if (!Number.isInteger(index)) return

      this.speakFrom(index)
    },

    async enableMediaSession() {
      if (!this.media) {
        this.media = createMediaSession({
          onPlay: () => this.togglePlayback(),
          onPause: () => this.speech?.pause(),
          onStop: () => this.closeSpeech(),
          onNext: () => this.speechNext(),
          onPrevious: () => this.speechPrevious(),
        })
      }

      await this.media.enable({
        title: this.displayedTitle || '',
        artist: this.$store.getSourceLabel(this.article),
        artwork: this.article?.image || '',
        // The native notification renders its own buttons — hand it the app's words.
        labels: {
          play: this.$t('article.player.play'),
          pause: this.$t('article.player.pause'),
          stop: this.$t('article.player.stop'),
          next: this.$t('article.player.next'),
          previous: this.$t('article.player.previous'),
          channel: this.$t('article.player.channel'),
        },
      })
    },

    showSpeechError(err) {
      console.error('[ReadingView] speech failed:', err?.message)

      const key = SPEECH_ERROR_KEYS[err?.message] || 'speakFailed'
      f7.toast.show({ text: this.$t(`article.${key}`), closeTimeout: 3000 })
    },

    async summarize() {
      if (this.summarizing) return

      this.summarizing = true
      try {
        this.summary = await summarizeArticle(
          { title: this.article.title, text: htmlToText(this.articleHtml) },
          this.$store.settings.ai,
          // The app language — the summary is FOR the reader, whatever the article speaks.
          { language: this.uiLanguage },
        )
        await this.$store.setSummary(this.article.id, this.summary)
      } catch (err) {
        this.showAiError(err)
      } finally {
        this.summarizing = false
      }
    },

    async toggleTranslation() {
      if (this.translating) return

      // Already translated once — just flip back and forth, don't spend the key again.
      if (this.translatedHtml) {
        this.showTranslation = !this.showTranslation
        this.translationNote = this.showTranslation ? this.$t('article.translated') : null
        this.renderIframe()
        return
      }

      if (!this.aiReady) {
        f7.toast.show({ text: this.$t('settings.ai.errors.notConfigured'), closeTimeout: 3000 })
        return
      }

      await this.runTranslation()
    },

    /**
     * The streaming translation. The article stays on screen the whole time:
     * untranslated paragraphs are dimmed, and every paragraph swaps to its
     * translation the moment its closing tag arrives from the stream — the reader
     * starts reading while the rest is still being paid for. An interruption
     * (backgrounded app, dead network, empty credit) keeps everything already
     * translated; the next tap resumes at the first missing chunk.
     */
    async runTranslation() {
      const target = this.uiLanguage

      if (!this.translationJob || this.translationJob.target !== target) {
        const blocks = splitHtmlBlocks(this.articleHtml)
        if (blocks.length === 0) {
          this.showAiError(new Error('no_content'))
          return
        }
        this.translationJob = {
          target,
          blocks,
          plan: planTranslationChunks(blocks, TRANSLATION_CHUNK_CHARS),
          done: [],
          title: null,
        }
      }
      const job = this.translationJob
      this.previewedBlocks = job.plan
        .slice(0, job.done.length)
        .reduce((n, chunk) => n + chunk.count, 0)

      // The paragraphs the speech controller points at are about to be replaced.
      await this.closeSpeech()

      this.translating = true
      // Safe even though nothing is translated yet: displayedHtml/-Title only
      // switch once translatedHtml/-Title actually exist. Flipping it now is what
      // shows the translated headline in the navbar the moment it arrives.
      this.showTranslation = true
      this.updateTranslationNote()
      this.applyTranslationDom()

      try {
        // Title first — it is one small request, and the reader sees the article
        // change language immediately instead of after the first 6k characters.
        if (job.title === null) {
          job.title = await translateText(this.article.title, this.$store.settings.ai, {
            targetLanguage: target,
          })
          this.translatedTitle = job.title || null
          this.applyTranslatedTitleDom()
        }

        await translateArticleBlocks(job.blocks, this.$store.settings.ai, {
          targetLanguage: target,
          fromChunk: job.done.length,
          onBlockPreview: (index, html) => {
            this.applyBlockPreviewDom(index, html)
            this.previewedBlocks = index + 1
            this.updateTranslationNote()
          },
          onChunkDone: (index, html) => {
            job.done[index] = html
            this.updateTranslationNote()
            // Authoritative per chunk — corrects whatever the previews got wrong.
            this.applyTranslationDom()
          },
        })

        // Model output is untrusted input, exactly like the publisher's HTML.
        this.translatedHtml = sanitizeArticleHtml(job.done.join(''))
        this.showTranslation = true
        this.translationNote = this.$t('article.translated')
        this.applyTranslationDom()
        await this.$store.setTranslation(this.article.id, {
          html: this.translatedHtml,
          title: this.translatedTitle || '',
          language: target,
        })
      } catch (err) {
        // Whatever is already translated stays on screen; the note says how to go on.
        this.translationNote = job.done.length > 0 ? this.$t('article.translationInterrupted') : null
        this.showAiError(err)
      } finally {
        this.translating = false
      }
    },

    /**
     * Rebuilds the iframe's article container from the job state: finished chunks
     * first (full strength), untranslated original blocks after (dimmed via CSS).
     * In-place DOM work instead of a new srcdoc, so the reader's scroll position
     * survives every update.
     */
    applyTranslationDom() {
      const doc = this.iframeEl?.contentDocument
      const container = doc?.querySelector('.article-body')
      const job = this.translationJob
      if (!container || !job) return

      if (this.translatedHtml) {
        container.innerHTML = this.translatedHtml
      } else {
        const doneHtml = sanitizeArticleHtml(job.done.join(''))
        const doneBlocks = job.plan.slice(0, job.done.length).reduce((n, c) => n + c.count, 0)
        const restHtml = sanitizeArticleHtml(job.blocks.slice(doneBlocks).join(''))
        container.innerHTML = `<div class="q-tx-done">${doneHtml}</div><div class="q-tx-rest">${restHtml}</div>`
      }
      this.measureIframe()
    },

    /** One streamed paragraph, swapped in while its chunk is still arriving. */
    applyBlockPreviewDom(blockIndex, html) {
      const doc = this.iframeEl?.contentDocument
      const rest = doc?.querySelector('.article-body .q-tx-rest')
      const job = this.translationJob
      if (!rest || !job) return

      const doneBlocks = job.plan.slice(0, job.done.length).reduce((n, c) => n + c.count, 0)
      const target = topLevelNodes(rest)[blockIndex - doneBlocks]
      if (!target) return

      // Exactly one sanitized node must replace exactly one original node — anything
      // else would shift the sibling indices the next preview relies on. When the
      // sanitizer disagrees, skip: the chunk's authoritative rebuild follows anyway.
      const parsed = doc.createElement('template')
      parsed.innerHTML = sanitizeArticleHtml(html)
      const replacement = topLevelNodes(parsed.content)
      if (replacement.length !== 1) return

      const node = replacement[0]
      // Full strength inside the dimmed rest — this paragraph is done.
      if (node.nodeType === 1) node.classList.add('q-tx-fresh')
      target.replaceWith(node)
      this.measureIframe()
    },

    applyTranslatedTitleDom() {
      const el = this.iframeEl?.contentDocument?.querySelector('.article-title')
      if (el && this.translatedTitle) el.textContent = this.translatedTitle
    },

    /**
     * Progress in PARAGRAPHS, because that is what the reader watches changing —
     * "1/2" for two six-thousand-character chunks reads like a stall. Streamed
     * previews already count; a finished chunk is authoritative.
     */
    updateTranslationNote() {
      const job = this.translationJob
      if (!job) return

      const doneBlocks = job.plan
        .slice(0, job.done.length)
        .reduce((n, chunk) => n + chunk.count, 0)
      const done = Math.min(job.blocks.length, Math.max(doneBlocks, this.previewedBlocks || 0))
      this.translationNote = this.$t('article.translatingProgress', { done, total: job.blocks.length })
    },

    measureIframe() {
      const height = this.iframeEl?.contentDocument?.body?.scrollHeight
      if (height) this.iframeHeight = `${height + 32}px`
    },

    showAiError(err) {
      if (err.message === 'aborted') return
      console.error('[ReadingView] AI request failed:', err.message)

      const key = `settings.ai.errors.${AI_ERROR_KEYS[err.message] || 'requestFailed'}`
      f7.toast.show({ text: this.$t(key), closeTimeout: 3500 })
    },

    async shareArticle() {
      await shareArticleTo(this.article, this.$t.bind(this))
    },
    async markUnread() {
      await this.$store.markUnread(this.article.id)
      this.f7router.back()
    },
    onIframeLoad(event) {
      this.iframeEl = event.target

      try {
        const doc = event.target.contentDocument
        if (!doc) return

        this.measureIframe()

        // sandbox="allow-same-origin": the article document is ours to reach into.
        // A fresh srcdoc means a fresh document, so both of these are per load.
        if (!doc.getElementById(SPEECH_STYLE_ID)) {
          const style = doc.createElement('style')
          style.id = SPEECH_STYLE_ID
          style.textContent = SPEECH_CSS
          doc.head.appendChild(style)
        }
        doc.addEventListener('click', this.onIframeClick)

        // A theme or font change rebuilds the srcdoc from the ORIGINAL html while a
        // translation is running or paused — put the translated part back on top.
        if (this.translationJob && !this.showTranslation
          && (this.translating || this.translationJob.done.length > 0)) {
          this.applyTranslationDom()
          this.applyTranslatedTitleDom()
        }
      } catch {}
    },
    updateOnlineStatus() {
      this.isOffline = !navigator.onLine
    },
  },
}
</script>
