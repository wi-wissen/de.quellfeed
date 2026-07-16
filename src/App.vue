<template>
  <f7-app v-bind="f7params">
    <f7-views tabs class="safe-areas">
      <f7-toolbar tabbar bottom>
        <f7-link tab-link="#view-feed" tab-link-active>
          <AppIcon name="newspaper-outline" />
          <span class="tabbar-label">{{ $t('nav.feed') }}</span>
        </f7-link>
        <f7-link tab-link="#view-saved" class="tab-link-stacked">
          <span class="tab-icon-stack" aria-hidden="true">
            <AppIcon name="bookmark-outline" class="tab-icon tab-icon--outline" />
            <AppIcon name="bookmark" class="tab-icon tab-icon--filled" />
          </span>
          <span class="tabbar-label">{{ $t('nav.saved') }}</span>
        </f7-link>
        <f7-link tab-link="#view-archive" class="tab-link-stacked">
          <span class="tab-icon-stack" aria-hidden="true">
            <AppIcon name="archive-outline" class="tab-icon tab-icon--outline" />
            <AppIcon name="archive" class="tab-icon tab-icon--filled" />
          </span>
          <span class="tabbar-label">{{ $t('nav.archive') }}</span>
        </f7-link>
      </f7-toolbar>

      <f7-view id="view-feed" tab main tab-active url="/"></f7-view>
      <f7-view id="view-saved" tab url="/saved/"></f7-view>
      <f7-view id="view-archive" tab url="/archive/"></f7-view>
    </f7-views>
  </f7-app>
</template>

<script>
import { f7, f7ready } from 'framework7-vue'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import routes from './routes.js'
import { consumePendingShares, listenForSharedLinks } from './utils/shareTarget.js'
import { parseSetupLink, describeSetupConfig } from './utils/setupLink.js'
import { storageGet, storageSet } from './utils/storage.js'

// Which tab was open when the app was last used — per device, hence plain storage and
// not a synced setting: the tablet on the sofa and the phone on the train are in
// different places of the same library.
const LAST_TAB_KEY = 'quell:lastTab'
const TAB_IDS = ['view-feed', 'view-saved', 'view-archive']

export default {
  name: 'App',

  data() {
    return {
      f7params: {
        name: 'Quell Feed',
        theme: 'auto',
        routes,
        // Long-pressing a list item opens its quick actions. Off by default in Framework7,
        // and its default delay (750ms) is slower than Android's own long-press.
        touch: { tapHold: true, tapHoldDelay: 500 },
      },
      colorSchemeQuery: null,
      stopShareListener: null,
      backButtonListener: null,
      appStateListener: null,
      appUrlListener: null,
      onTabShow: null,
    }
  },

  async mounted() {
    // The splash must outlive the LOCAL init: with auto-hide it vanished onto a white,
    // still empty WebView for the half second the storage read takes, and the list then
    // "popped in" dark. Only the local part, though — holding the splash through the
    // WebDAV sync and the feed refresh would punish every start with the network's
    // mood. try/finally, because a failed init must reveal the app, not leave the
    // splash up forever.
    try {
      await this.$store.initLocal()
      // Before the splash lifts, so the user never sees the feed flash by on the way
      // to where they actually were.
      await this.restoreLastTab()
    } finally {
      this.hideSplashScreen()
    }
    await this.$store.initRemote()

    this.colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
    this.colorSchemeQuery.addEventListener('change', this.onSystemThemeChange)

    this.stopShareListener = await listenForSharedLinks(this.onSharedLink)
    this.backButtonListener = await this.listenForBackButton()

    if (Capacitor.isNativePlatform()) {
      // Articles shared while the app was away sit in ShareActivity's queue.
      await this.importPendingShares()
      this.appStateListener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) this.importPendingShares()
      })

      // Setup deep links — both a warm open and the cold start that launched us.
      this.appUrlListener = await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        this.onAppUrl(url)
      })
      const launch = await CapacitorApp.getLaunchUrl()
      if (launch?.url) this.onAppUrl(launch.url)
    }
  },

  beforeUnmount() {
    this.colorSchemeQuery?.removeEventListener('change', this.onSystemThemeChange)
    this.stopShareListener?.()
    this.backButtonListener?.remove()
    this.appStateListener?.remove()
    this.appUrlListener?.remove()
    if (this.onTabShow) f7.off('tabShow', this.onTabShow)
  },

  methods: {
    /**
     * Reopens the tab the user last had open — the feed for feed people, the reading
     * list for reading-list people. Order matters twice here: f7 must be ready before
     * a tab can be shown, and the remember-listener attaches only AFTER the restore,
     * because the initial show of the default feed tab would otherwise overwrite the
     * very value being restored.
     */
    async restoreLastTab() {
      const lastTab = await storageGet(LAST_TAB_KEY)
      await new Promise(resolve => f7ready(resolve))

      if (TAB_IDS.includes(lastTab) && lastTab !== 'view-feed') {
        // No animation: this is where the app opens, not a transition the user made.
        f7.tab.show(`#${lastTab}`, false)
      }

      this.onTabShow = tabEl => {
        if (TAB_IDS.includes(tabEl?.id)) storageSet(LAST_TAB_KEY, tabEl.id)
      }
      f7.on('tabShow', this.onTabShow)
    },

    /**
     * Hides the launch splash — but only once the first THEMED frame is actually on
     * screen. Two animation frames: the first schedules the render with the loaded
     * articles and the applied theme, the second fires after that frame was painted.
     * Hiding any earlier shows exactly the white flash this exists to prevent.
     */
    hideSplashScreen() {
      if (!Capacitor.isNativePlatform()) return
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          try {
            const { SplashScreen } = await import('@capacitor/splash-screen')
            await SplashScreen.hide()
          } catch {
            // Never fatal — worst case the splash fades on its own terms.
          }
        })
      })
    },

    onSystemThemeChange() {
      if (this.$store.settings.theme === 'system') {
        this.$store.applyTheme()
      }
    },

    /**
     * Android's back gesture and back button.
     *
     * Capacitor dispatches both as this one event, and with no listener its default is to
     * walk the WebView's history — which is empty, because Framework7 routes in memory.
     * So the gesture did nothing at all. Everything below is that missing translation.
     */
    async listenForBackButton() {
      if (!Capacitor.isNativePlatform()) return null

      return CapacitorApp.addListener('backButton', () => {
        // An open sheet, dialog or popover swallows the back press first — anything else
        // would feel broken.
        if (document.querySelector('.actions-modal.modal-in, .dialog.modal-in, .popover.modal-in, .sheet-modal.modal-in')) {
          f7.actions.close()
          f7.dialog.close()
          f7.popover.close()
          f7.sheet.close()
          return
        }

        const router = f7.views.current?.router
        if (router?.history.length > 1) {
          router.back()
          return
        }

        // At the root of the tab: leave the app, but do not kill it — coming back should
        // land where you left.
        CapacitorApp.minimizeApp()
      })
    },

    /**
     * A link shared into the app from Android's share sheet.
     *
     * A feed is a decision — it needs the app, and the subscribe screen. An article is
     * not: saving it IS the whole intent of the share, so it saves silently, says so in a
     * native toast (which outlives the app going away) and hands you back to where you
     * were. You never wanted to be here.
     */
    async onSharedLink(url, kind) {
      if (kind === 'feed') {
        // The view the user is actually looking at — pushing into `views.main` while the
        // Saved tab is open would open the page in the tab behind it.
        const router = f7.views.current?.router || f7.views.main.router
        router.navigate('/add-feed/', { props: { initialUrl: url } })
        return
      }

      try {
        // Deliberately without the article title: an Android toast truncates long
        // titles into noise, and the verdict — saved, or not — must come first.
        await this.$store.addLink(url)
        await this.leaveWithToast(this.$t('addLink.addedShort'))
      } catch (err) {
        const key = err.message === 'already_added' ? 'addLink.alreadyAdded' : 'addLink.error'
        await this.leaveWithToast(this.$t(key))
      }
    },

    /**
     * A Framework7 toast lives in the WebView and dies with it, so minimizing the app
     * would hide the very confirmation the user is waiting for. The native toast is drawn
     * by Android and survives.
     */
    async leaveWithToast(text) {
      const { Toast } = await import('@capacitor/toast')
      await Toast.show({ text, duration: 'short' })
      await CapacitorApp.minimizeApp()
    },

    /**
     * Imports what ShareActivity queued while the app was in the background or closed.
     * ShareActivity already toasted "saved" at share time, so this stays quiet unless
     * something actually arrives — and it never minimizes the app: the user opened it.
     */
    async importPendingShares() {
      const urls = await consumePendingShares()
      let imported = 0

      for (const url of urls) {
        try {
          await this.$store.addLink(url)
          imported += 1
        } catch (err) {
          // `already_added` is a re-share of something we have — silently fine.
          if (err.message !== 'already_added') {
            console.warn('[shares] import failed:', err.message)
            f7.toast.show({ text: this.$t('addLink.error'), closeTimeout: 3000 })
          }
        }
      }

      if (imported > 0) {
        f7.toast.show({
          text: this.$t('addLink.imported', imported),
          closeTimeout: 2500,
        })
      }
    },

    /**
     * A setup deep link (de.quellfeed://setup#…) from the toolbox page carries an AI
     * configuration. NEVER applied silently: any QR code or web page can fire one, and a
     * crafted link could otherwise quietly repoint the AI base URL at a server that then
     * reads every summarized article. The dialog shows what would change; the key stays
     * masked to its last characters.
     */
    async onAppUrl(url) {
      let patch
      try {
        patch = parseSetupLink(url)
      } catch {
        f7.toast.show({ text: this.$t('setupLink.invalid'), closeTimeout: 3000 })
        return
      }
      if (!patch) return // some other deep link — nothing we handle yet

      const shown = describeSetupConfig(patch.ai) // already HTML-escaped — F7 renders HTML
      f7.dialog.confirm(
        this.$t('setupLink.body', {
          provider: shown.provider,
          baseUrl: shown.baseUrl,
          model: shown.model,
          keyEnding: shown.keyEnding,
        }),
        this.$t('setupLink.title'),
        async () => {
          await this.$store.setAiSettings(patch.ai)
          f7.toast.show({ text: this.$t('setupLink.applied'), closeTimeout: 2500 })
        }
      )
    },
  },
}
</script>
