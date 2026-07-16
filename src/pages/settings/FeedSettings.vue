<template>
  <f7-page name="settings-feeds" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.feeds.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-list strong inset dividers>
      <f7-list-item link="/add-feed/" :title="$t('add.feed')">
        <template #media>
          <AppIcon name="add-circle-outline" class="color-accent" />
        </template>
      </f7-list-item>
    </f7-list>

    <f7-block-title>{{ $t('settings.feeds') }}</f7-block-title>

    <f7-block v-if="feeds.length === 0" strong inset class="settings-empty">
      {{ $t('settings.noFeeds') }}
    </f7-block>

    <f7-list v-else strong inset dividers>
      <!-- Tapping opens the feed's detail page (AI filter, delete, …). The swipe stays
           as the delete shortcut; the once-visible trash button moved onto the detail
           page — an <a> inside the item link's <a> would be invalid markup, and mouse
           users reach the delete through the tap now anyway. -->
      <f7-list-item
        v-for="feed in feeds"
        :key="feed.id"
        swipeout
        :link="`/settings/feeds/${feed.id}/`"
        :title="feed.title"
      >
        <template #media>
          <AppIcon name="logo-rss" class="color-warning" />
        </template>
        <template #subtitle>
          <span class="feed-item-url">{{ feed.url }}</span>
        </template>
        <template #footer>
          <span class="feed-item-url">{{ formatLastFetched(feed.lastFetched) }}</span>
        </template>
        <f7-swipeout-actions right>
          <f7-swipeout-button color="red" close @click="confirmRemoveFeed(feed)">
            {{ $t('settings.deleteFeed') }}
          </f7-swipeout-button>
        </f7-swipeout-actions>
      </f7-list-item>
    </f7-list>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'

export default {
  name: 'FeedSettings',

  mixins: [hidesTabbar],

  computed: {
    feeds() {
      return this.$store.feeds
    },
  },

  methods: {
    formatLastFetched(iso) {
      if (!iso) return this.$t('settings.never')
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    },
    async confirmRemoveFeed(feed) {
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
    },
  },
}
</script>
