<template>
  <f7-list-item
    swipeout
    class="article-card-item"
    @click.stop
  >
    <!--
      The two gestures go to the two verbs of the list the card sits in. Trailing edge
      (swipe left) is the consequential one everywhere — save or delete in the feed,
      archive in the saved list, restore in the archive.

      The leading edge (swipe right) shares, in EVERY list. It used to toggle read in
      the saved and archive lists (the iOS Mail muscle memory), but device testing
      overruled that: one gesture with two meanings is worse than one verb everywhere,
      and read/unread is bookkeeping the hold menu covers.

      Overswipe: swipe far and the action fires on release; swipe a little and the button
      stays to be tapped. The one exception is deleting a link, where overswipe is off on
      purpose: there is no undo, and the deletion writes a tombstone that removes the link
      from every synced device and from KaraKeep/Linkwarden too. Far too much to hang on a
      gesture a hand can make by accident.

      Archive/restore are harmless and reversible, so overswipe stays on; deleting lives
      in the hold menu there — the rare, destructive branch does not get a gesture.
    -->
    <f7-swipeout-actions right>
      <f7-swipeout-button
        v-if="context === 'saved'"
        color="teal"
        overswipe
        close
        @click="onToggleArchive"
      >
        <AppIcon name="archive-outline" />
      </f7-swipeout-button>
      <f7-swipeout-button
        v-else-if="context === 'archive'"
        color="teal"
        overswipe
        close
        @click="onToggleArchive"
      >
        <AppIcon name="arrow-undo-outline" />
      </f7-swipeout-button>
      <f7-swipeout-button
        v-else
        :color="isLink ? 'red' : 'yellow'"
        :overswipe="!isLink"
        close
        @click="onToggleSave"
      >
        <AppIcon :name="saveActionIcon" />
      </f7-swipeout-button>
    </f7-swipeout-actions>

    <f7-swipeout-actions left>
      <f7-swipeout-button
        color="blue"
        overswipe
        close
        @click="onShare"
      >
        <AppIcon name="share-outline" />
      </f7-swipeout-button>
    </f7-swipeout-actions>

    <template #inner>
      <div
        ref="card"
        :class="['article-card', article.isSaved && 'is-saved', !article.isRead && 'is-unread', quelled && 'is-quelled']"
        role="button"
        tabindex="0"
        @click="onTap"
        @keydown.enter.prevent="onTap"
        @keydown.space.prevent="onTap"
      >
        <div class="article-card__text">
          <div class="article-card__meta">
            <AppIcon v-if="isLink" name="link-outline" size="inline" class="article-card__link-icon" />
            {{ sourceLabel }}&thinsp;·&thinsp;{{ timeAgo }}<template v-if="quelled">&thinsp;·&thinsp;<span class="article-card__quelled-tag">{{ $t('article.quelled') }}</span></template>
          </div>
          <p :class="['article-card__title', !article.isRead && 'unread']">
            {{ article.title }}
          </p>
          <p class="article-card__excerpt">{{ article.description }}</p>
        </div>

        <div
          v-if="thumbUrl"
          :class="['article-card__thumb', isIconThumb && 'article-card__thumb--favicon']"
          :style="thumbStyle"
        >
          <img :src="thumbUrl" :alt="article.title" @error="onImgError" />
        </div>
      </div>
    </template>
  </f7-list-item>
</template>

<script>
import { f7 } from 'framework7-vue'
import { relativeTime } from '../utils/time.js'
import { getFaviconFallbackUrl, getFaviconUrl } from '../utils/favicon.js'
import { shareArticle } from '../utils/share.js'
import { bindLongPress } from '../utils/addMenu.js'

export default {
  name: 'ArticleCard',

  props: {
    article: {
      type: Object,
      required: true,
    },
    sourceLabel: {
      type: String,
      default: '',
    },
    // True when the list shows this article although the AI filter quelled it — the
    // card renders dimmed, tagged, and offers "unquell" in the hold menu. A prop, not
    // read off the article, because only the Feed tab renders quelled state at all.
    quelled: {
      type: Boolean,
      default: false,
    },
    // Which list the card sits in: 'feed' (default), 'saved' or 'archive'. It decides
    // what the trailing swipe does — save/delete in the feed, archive in the saved
    // list, restore in the archive.
    context: {
      type: String,
      default: 'feed',
    },
  },

  emits: ['tap', 'toggle-save', 'toggle-read', 'remove', 'unquell'],

  data() {
    return {
      // 0 = the article image or the site's own favicon, 1 = the DuckDuckGo fallback,
      // 2 = give up and show no thumbnail at all.
      thumbAttempt: 0,
      thumbSize: 72,
    }
  },

  computed: {
    isLink() {
      return !this.article.feedId
    },
    // Unsaving a link deletes it — there is no feed to bring it back — so the
    // swipe action says "delete", not "unsave".
    saveActionIcon() {
      if (this.isLink) return 'trash-bin-outline'
      return this.article.isSaved ? 'bookmark' : 'bookmark-outline'
    },
    // Tried in order, each one only after the one before it failed to load.
    thumbCandidates() {
      return [
        this.article.image,
        getFaviconUrl(this.article.url),
        getFaviconFallbackUrl(this.article.url),
      ].filter(Boolean)
    },
    thumbUrl() {
      return this.thumbCandidates[this.thumbAttempt] || null
    },
    // Anything but the article's own image is an icon, and gets the icon's padded frame.
    isIconThumb() {
      return this.thumbUrl !== this.article.image
    },
    thumbStyle() {
      return {
        width: `${this.thumbSize}px`,
        height: `${this.thumbSize}px`,
      }
    },
    timeAgo() {
      return relativeTime(this.article.publishedAt, this.$t.bind(this))
    },
  },

  // Deliberately not in data(): neither the open action sheet nor the unbind function is
  // rendered, and wrapping a Framework7 instance in a reactive proxy only invites trouble.
  created() {
    this.actionsSheet = null
    this.unbindLongPress = null
  },

  mounted() {
    this.unbindLongPress = bindLongPress(this.$refs.card, this.openActionMenu)
  },

  beforeUnmount() {
    this.unbindLongPress?.()
    this.actionsSheet?.destroy()
    this.actionsSheet = null
  },

  methods: {
    onTap() {
      this.$emit('tap', this.article)
    },
    onToggleSave() {
      this.$emit('toggle-save', this.article.id)
    },
    onToggleRead() {
      this.$emit('toggle-read', this.article.id)
    },
    onRemove() {
      this.$emit('remove', this.article.id)
    },
    // Straight to the store, not an emit: the card also lives in pages this feature must
    // not require changes to (the Feed tab), and archiving means the same thing wherever
    // the card is shown — there is nothing page-specific for a parent to decide.
    async onToggleArchive() {
      if (this.article.isArchived) await this.$store.unarchiveArticle(this.article.id)
      else await this.$store.archiveArticle(this.article.id)
    },
    async onShare() {
      await shareArticle(this.article, this.$t.bind(this))
    },
    onImgError() {
      this.thumbAttempt += 1
    },

    /**
     * Every quick action of the card, in one menu — for everyone who has no idea that a
     * card can be swiped at all. Swiping stays the fast path; this is the discoverable one.
     *
     * A link gets no save/unsave entry: it is always saved, and unsaving one *is* deleting
     * it (see store.toggleSave). Showing both would be two names for one button.
     */
    buildMenuButtons() {
      const t = this.$t.bind(this)
      const buttons = [
        {
          text: this.article.title,
          label: true,
        },
        {
          text: t('article.open'),
          onClick: () => this.onTap(),
        },
      ]

      if (!this.isLink) {
        // Removing from the reading list is destructive from the reader's point of
        // view — it says what it does and is red, like the link's delete below.
        buttons.push(
          this.article.isSaved
            ? { text: t('article.removeFromList'), color: 'red', onClick: () => this.onToggleSave() }
            : { text: t('article.save'), onClick: () => this.onToggleSave() }
        )
      }

      buttons.push({
        text: t('article.share'),
        onClick: () => this.onShare(),
      })

      // Archive = "done reading, keep forever". Available on every card: a feed article
      // that gets archived becomes a saved one (the store enforces that), a link simply
      // moves shelves.
      buttons.push({
        text: this.article.isArchived ? t('article.unarchive') : t('article.archive'),
        onClick: () => this.onToggleArchive(),
      })

      buttons.push({
        text: this.article.isRead ? t('article.markUnread') : t('article.markRead'),
        onClick: () => this.onToggleRead(),
      })

      // Same wording and behaviour as the reading view's More menu — the hold menu
      // is that menu, one screen earlier.
      buttons.push({
        text: t('article.openInBrowser'),
        onClick: () => window.open(this.article.url, '_blank'),
      })

      if (this.quelled) {
        buttons.push({
          text: t('article.unquell'),
          onClick: () => this.$emit('unquell', this.article.id),
        })
      }

      if (this.isLink) {
        buttons.push({
          text: t('article.delete'),
          color: 'red',
          onClick: () => this.onRemove(),
        })
      }

      return buttons
    },

    openActionMenu() {
      // Android can deliver both a `taphold` and a `contextmenu` for one long press. The
      // first one through builds the sheet; the second must not stack a second one on top.
      if (this.actionsSheet) return

      this.actionsSheet = f7.actions.create({
        buttons: [
          this.buildMenuButtons(),
        ],
        on: {
          // Built per press, so it must not pile up in the DOM.
          closed: () => {
            this.actionsSheet?.destroy()
            this.actionsSheet = null
          },
        },
      })

      this.actionsSheet.open()
    },
  },
}
</script>
