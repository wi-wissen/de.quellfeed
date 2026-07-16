<template>
  <f7-page name="settings-feed-detail" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ feed ? feed.title : $t('settings.feedDetail.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- The guard matters: deleting the feed below removes it from the store while
         this page is still open — everything after that renders against nothing. -->
    <template v-if="feed">
      <f7-list strong inset dividers>
        <f7-list-item
          class="feed-detail-url"
          :header="$t('settings.feedDetail.url')"
          :title="feed.url"
        >
          <template #media>
            <AppIcon name="logo-rss" class="color-warning" />
          </template>
        </f7-list-item>
      </f7-list>

      <f7-block-title>{{ $t('settings.feedDetail.filterTitle') }}</f7-block-title>
      <f7-list strong inset>
        <f7-list-input
          type="textarea"
          outline
          resizable
          :label="$t('settings.feedDetail.filterLabel')"
          :placeholder="$t('settings.feedDetail.filterPlaceholder')"
          :value="filterPrompt"
          @input="filterPrompt = $event.target.value"
          @change="persistFilter"
        ></f7-list-input>
      </f7-list>
      <f7-block-footer>
        <p>{{ $t('settings.feedDetail.filterHint') }}</p>
        <!-- Without a key the prompt is written but dead — say so, and point at the fix. -->
        <p v-if="!aiReady">
          {{ $t('settings.feedDetail.needsAiKey') }}
          <f7-link href="/settings/ai/">{{ $t('settings.feedDetail.openAiSettings') }}</f7-link>
        </p>
        <p>{{ $t('settings.feedDetail.quelledCount', { n: quelledCount }) }}</p>
      </f7-block-footer>

      <f7-list strong inset>
        <f7-list-button color="red" @click="confirmRemoveFeed">
          {{ $t('settings.deleteFeed') }}
        </f7-list-button>
      </f7-list>
    </template>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'

export default {
  name: 'FeedDetailPage',

  mixins: [hidesTabbar],

  props: {
    f7router: Object,
    f7route: Object,
  },

  data() {
    return {
      // Local while typing; persisted on change/leave. Persisting per keystroke would
      // stamp the feed's updatedAt over and over and spam the WebDAV merge.
      filterPrompt: '',
    }
  },

  computed: {
    feedId() {
      return this.f7route?.params?.feedId || ''
    },
    feed() {
      return this.$store.getFeedById(this.feedId)
    },
    aiReady() {
      return this.$store.aiReady
    },
    quelledCount() {
      return this.$store.getQuelledCount(this.feedId)
    },
  },

  created() {
    this.filterPrompt = this.feed?.filterPrompt || ''
  },

  methods: {
    async persistFilter() {
      if (!this.feed) return
      await this.$store.setFeedFilterPrompt(this.feed.id, this.filterPrompt)
    },
    // hidesTabbar calls this on page:beforeout — the textarea's change event does not
    // fire when the page is left via the back swipe while the field still has focus.
    onPageOutExtra() {
      this.persistFilter()
    },
    async confirmRemoveFeed() {
      const feed = this.feed
      if (!feed) return

      const confirmed = await new Promise(resolve => {
        this.$f7.dialog.confirm(
          this.$t('settings.deleteFeedConfirm', { title: feed.title }),
          this.$t('settings.deleteFeed'),
          () => resolve(true),
          () => resolve(false),
        )
      })
      if (!confirmed) return

      await this.$store.removeFeed(feed.id)
      this.$f7.toast.show({
        text: this.$t('settings.feedDeleted', { title: feed.title }),
        closeTimeout: 2500,
      })
      this.f7router.back()
    },
  },
}
</script>
