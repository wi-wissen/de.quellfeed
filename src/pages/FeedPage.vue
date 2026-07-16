<template>
  <f7-page
    name="feed"
    class="article-list"
    :ptr="!isOffline"
    @ptr:refresh="onPullRefresh"
  >
    <f7-navbar>
      <f7-nav-title>{{ $t('nav.feed') }}</f7-nav-title>
      <f7-nav-right>
        <!-- Tap subscribes to a feed — that is what this tab is. Hold for the other way in. -->
        <f7-link ref="addButton" class="nav-icon-link" @click="onAdd">
          <AppIcon name="add-outline" :label="$t('add.title')" />
        </f7-link>
        <f7-link href="/settings/" class="nav-icon-link">
          <AppIcon name="settings-outline" :label="$t('settings.title')" />
        </f7-link>
        <!-- Overflow menu: view options that are not worth a permanent icon of their own. -->
        <f7-link class="nav-icon-link" @click="openFeedMenu">
          <AppIcon name="ellipsis-horizontal-outline" :label="$t('feed.menu')" />
        </f7-link>
      </f7-nav-right>
    </f7-navbar>

    <template v-if="articles.length === 0 && !$store.refreshing">
      <div class="empty-state">
        <div class="empty-state__icon">
          <AppIcon name="logo-rss" size="xl" />
        </div>
        <p class="empty-state__text">
          {{ $t('feed.empty', { plus: '+' }) }}
        </p>
      </div>
    </template>

    <template v-else>
      <f7-list media-list no-hairlines class="no-margin-top">
        <ArticleCard
          v-for="article in articles"
          :key="article.id"
          :article="article"
          :source-label="$store.getSourceLabel(article)"
          :quelled="Boolean(article.isQuelled)"
          @tap="openArticle"
          @toggle-save="toggleSave"
          @toggle-read="toggleRead"
          @remove="removeArticle"
          @unquell="unquellArticle"
        />
      </f7-list>
    </template>
  </f7-page>
</template>

<script>
import { f7 } from 'framework7-vue'
import ArticleCard from '../components/ArticleCard.vue'
import { addForTab, openAddMenu, bindLongPress } from '../utils/addMenu.js'

export default {
  name: 'FeedPage',

  components: { ArticleCard },

  props: {
    f7router: Object,
    f7route: Object,
  },

  data() {
    return {
      isOffline: !navigator.onLine,
    }
  },

  computed: {
    articles() {
      return this.$store.feedArticles
    },
  },

  created() {
    this.unbindLongPress = null
    // Framework7 instance, kept off data() on purpose — see ArticleCard for why.
    this.feedMenuSheet = null
  },

  mounted() {
    window.addEventListener('online', this.updateOnlineStatus)
    window.addEventListener('offline', this.updateOnlineStatus)
    this.unbindLongPress = bindLongPress(this.addButtonEl(), this.openAddMenu)
  },

  beforeUnmount() {
    window.removeEventListener('online', this.updateOnlineStatus)
    window.removeEventListener('offline', this.updateOnlineStatus)
    this.unbindLongPress?.()
    this.feedMenuSheet?.destroy()
    this.feedMenuSheet = null
  },

  methods: {
    // f7-link is a component, so the ref is the instance — the <a> we need to listen on
    // is its root element.
    addButtonEl() {
      const ref = this.$refs.addButton
      return ref?.$el || ref || null
    },
    onAdd() {
      addForTab(this.f7router, 'feed')
    },
    openAddMenu() {
      openAddMenu(this.f7router, this.$t.bind(this), 'feed')
    },
    async onPullRefresh(done) {
      if (this.isOffline) {
        f7.toast.show({ text: this.$t('refresh.offline'), closeTimeout: 2000 })
        done()
        return
      }
      try {
        await this.$store.refreshAll()
      } catch {
        f7.toast.show({ text: this.$t('refresh.error'), closeTimeout: 2000 })
      } finally {
        done()
      }
    },
    openArticle(article) {
      this.f7router.navigate('/article/', { props: { articleId: article.id } })
    },
    async toggleSave(articleId) {
      await this.$store.toggleSave(articleId)
    },
    async toggleRead(articleId) {
      const article = this.$store.getArticleById(articleId)
      if (!article) return
      if (article.isRead) await this.$store.markUnread(articleId)
      else await this.$store.markRead(articleId)
    },
    async removeArticle(articleId) {
      await this.$store.removeArticle(articleId)
    },
    async unquellArticle(articleId) {
      await this.$store.unquellArticle(articleId)
    },
    /**
     * The three-dots menu. Its one entry toggles whether quelled (AI-suppressed)
     * articles are shown, dimmed, instead of hidden — persisted as a setting, so
     * the choice survives restarts.
     */
    openFeedMenu() {
      if (this.feedMenuSheet) return

      const showQuelled = this.$store.settings.showQuelled
      this.feedMenuSheet = f7.actions.create({
        buttons: [
          [
            {
              // An actions sheet has no toggle control, so the checkmark carries the state.
              text: `${showQuelled ? '✓ ' : ''}${this.$t('feed.showQuelled')}`,
              onClick: () => this.$store.setShowQuelled(!showQuelled),
            },
          ],
        ],
        on: {
          closed: () => {
            this.feedMenuSheet?.destroy()
            this.feedMenuSheet = null
          },
        },
      })

      this.feedMenuSheet.open()
    },
    updateOnlineStatus() {
      this.isOffline = !navigator.onLine
    },
  },
}
</script>
