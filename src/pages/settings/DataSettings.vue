<template>
  <f7-page name="settings-data" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.data.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- Feeds -->
    <f7-block-title>OPML · {{ $t('settings.feeds') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item class="settings-action-item" :title="$t('settings.importOpml')" @click="importOpml">
        <template #media>
          <AppIcon name="arrow-down-outline" class="color-success" />
        </template>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.exportOpml')"
        :footer="feedCount === 0 ? $t('settings.noFeeds') : $t('settings.feedCount', { n: feedCount })"
        @click="exportOpmlFile"
      >
        <template #media>
          <AppIcon name="arrow-up-outline" class="color-accent" />
        </template>
      </f7-list-item>
    </f7-list>

    <!-- Reading list -->
    <f7-block-title>{{ $t('settings.bookmarks') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.importBookmarks')"
        @click="importBookmarks"
      >
        <template #media>
          <AppIcon name="arrow-down-outline" class="color-success" />
        </template>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.exportBookmarks')"
        :footer="savedCount === 0 ? $t('settings.noBookmarks') : $t('settings.bookmarkCount', { n: savedCount })"
        @click="exportBookmarksFile"
      >
        <template #media>
          <AppIcon name="arrow-up-outline" class="color-accent" />
        </template>
      </f7-list-item>
    </f7-list>

    <!-- Archive — the same bookmark format, its own file: a round trip restores
         each article onto the shelf it came from. -->
    <f7-block-title>{{ $t('nav.archive') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.importArchive')"
        @click="importArchive"
      >
        <template #media>
          <AppIcon name="arrow-down-outline" class="color-success" />
        </template>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.exportArchive')"
        :footer="archiveCount === 0 ? $t('settings.noArchive') : $t('settings.archiveCount', { n: archiveCount })"
        @click="exportArchiveFile"
      >
        <template #media>
          <AppIcon name="arrow-up-outline" class="color-accent" />
        </template>
      </f7-list-item>
    </f7-list>
    <f7-block-footer>{{ $t('settings.bookmarksHint') }}</f7-block-footer>

    <input
      ref="opmlInput"
      type="file"
      accept=".opml,application/xml,text/xml"
      style="display:none"
      @change="onOpmlFile"
    />
    <input
      ref="bookmarksInput"
      type="file"
      accept=".html,.htm,text/html"
      style="display:none"
      @change="onBookmarksFile"
    />
    <input
      ref="archiveInput"
      type="file"
      accept=".html,.htm,text/html"
      style="display:none"
      @change="onArchiveFile"
    />
  </f7-page>
</template>

<script>
import { Share } from '@capacitor/share'
import { hidesTabbar } from '../../utils/tabbar.js'
import { exportOpml, parseOpml } from '../../utils/opml.js'

export default {
  name: 'DataSettings',

  mixins: [hidesTabbar],

  computed: {
    feedCount() {
      return this.$store.feeds.length
    },
    savedCount() {
      return this.$store.savedArticles.length
    },
    archiveCount() {
      return this.$store.archivedArticles.length
    },
  },

  methods: {
    importOpml() {
      this.$refs.opmlInput.click()
    },
    async onOpmlFile(event) {
      const file = event.target.files[0]
      event.target.value = ''
      if (!file) return

      const items = parseOpml(await file.text())
      let added = 0
      for (const item of items) {
        try {
          await this.$store.addFeed(item.url)
          added++
        } catch {
          // already subscribed, or the feed no longer resolves — skip it
        }
      }
      this.toast(this.$t('settings.opmlImported', { n: added }))
    },
    async exportOpmlFile() {
      await this.shareFile(exportOpml(this.$store.feeds), 'quellfeed-feeds.opml', 'application/xml')
    },

    importBookmarks() {
      this.$refs.bookmarksInput.click()
    },
    async onBookmarksFile(event) {
      const file = event.target.files[0]
      event.target.value = ''
      if (!file) return

      const { imported, skipped } = await this.$store.importBookmarks(await file.text())
      this.toast(this.$t('settings.bookmarksImported', { imported, skipped }))
    },
    async exportBookmarksFile() {
      await this.shareFile(this.$store.exportReadingList(), 'quellfeed-reading-list.html', 'text/html')
    },

    importArchive() {
      this.$refs.archiveInput.click()
    },
    async onArchiveFile(event) {
      const file = event.target.files[0]
      event.target.value = ''
      if (!file) return

      const { imported, skipped } = await this.$store.importBookmarks(await file.text(), { archive: true })
      this.toast(this.$t('settings.bookmarksImported', { imported, skipped }))
    },
    async exportArchiveFile() {
      await this.shareFile(this.$store.exportArchive(), 'quellfeed-archive.html', 'text/html')
    },

    /**
     * Hands a generated file to the share sheet, falling back to a browser download.
     *
     * KNOWN GAP: on native Android a blob: URL is not a shareable file — that needs
     * @capacitor/filesystem to write a real file and share its URI. Works in the web
     * build (download fallback); revisit when the Android build lands.
     */
    async shareFile(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      try {
        const { value } = await Share.canShare()
        if (!value) throw new Error('unavailable')
        await Share.share({ title: filename, url, dialogTitle: filename })
      } catch {
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
      } finally {
        URL.revokeObjectURL(url)
      }
    },
    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 2500 })
    },
  },
}
</script>
