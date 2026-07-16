<template>
  <f7-page name="saved" class="article-list saved-list">
    <f7-navbar>
      <f7-nav-title>{{ $t('nav.saved') }}</f7-nav-title>
      <f7-nav-right>
        <!-- Tap saves a link — that is what this tab is. Hold for the other way in. -->
        <f7-link ref="addButton" class="nav-icon-link" @click="onAdd">
          <AppIcon name="add-outline" :label="$t('add.title')" />
        </f7-link>
        <f7-link href="/settings/" class="nav-icon-link">
          <AppIcon name="settings-outline" :label="$t('settings.title')" />
        </f7-link>
      </f7-nav-right>
    </f7-navbar>

    <template v-if="articles.length === 0">
      <div class="empty-state">
        <div class="empty-state__icon">
          <AppIcon name="bookmark-outline" size="xl" />
        </div>
        <p class="empty-state__text">{{ $t('saved.empty') }}</p>
      </div>
    </template>

    <template v-else>
      <f7-list media-list no-hairlines class="no-margin-top">
        <ArticleCard
          v-for="article in articles"
          :key="article.id"
          :article="article"
          :source-label="$store.getSourceLabel(article)"
          context="saved"
          @tap="openArticle"
          @toggle-save="toggleSave"
          @toggle-read="toggleRead"
          @remove="removeArticle"
        />
      </f7-list>
    </template>
  </f7-page>
</template>

<script>
import ArticleCard from '../components/ArticleCard.vue'
import { addForTab, openAddMenu, bindLongPress } from '../utils/addMenu.js'

export default {
  name: 'SavedPage',

  components: { ArticleCard },

  props: {
    f7router: Object,
    f7route: Object,
  },

  computed: {
    // The reading list only — the archive is its own tab (ArchivePage).
    articles() {
      return this.$store.savedArticles
    },
  },

  created() {
    this.unbindLongPress = null
  },

  mounted() {
    this.unbindLongPress = bindLongPress(this.addButtonEl(), this.openAddMenu)
  },

  beforeUnmount() {
    this.unbindLongPress?.()
  },

  methods: {
    // f7-link is a component, so the ref is the instance — the <a> we need to listen on
    // is its root element.
    addButtonEl() {
      const ref = this.$refs.addButton
      return ref?.$el || ref || null
    },
    onAdd() {
      addForTab(this.f7router, 'saved')
    },
    openAddMenu() {
      openAddMenu(this.f7router, this.$t.bind(this), 'saved')
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
  },
}
</script>
