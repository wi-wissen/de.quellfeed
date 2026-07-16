<template>
  <f7-page
    name="add-feed"
    @page:beforein="onPageIn"
    @page:beforeout="onPageOut"
  >
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('addFeed.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('addFeed.label')"
        :placeholder="$t('addFeed.placeholder')"
        :value="url"
        clear-button
        @input="onUrlInput"
        @keyup.enter="searchFeeds"
        inputmode="url"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
      ></f7-list-input>
    </f7-list>

    <f7-block>
      <f7-button
        fill
        large
        :disabled="!url.trim() || loading"
        @click="searchFeeds"
      >
        <f7-preloader v-if="loading" color="white"></f7-preloader>
        <span v-else>{{ $t('addFeed.add') }}</span>
      </f7-button>
    </f7-block>

    <f7-block v-if="loading" class="settings-note">
      {{ $t('addFeed.searching') }}
    </f7-block>

    <f7-block v-else-if="errorMsg" class="text-color-red">
      {{ errorMsg }}
    </f7-block>

    <template v-else-if="candidates.length > 0">
      <f7-block-title>{{ $t('addFeed.multiple', { n: candidates.length }) }}</f7-block-title>
      <f7-list strong inset dividers>
        <f7-list-item
          v-for="candidate in candidates"
          :key="candidate.url"
          link="#"
          :title="candidate.title"
          :footer="candidate.url"
          @click="addFeed(candidate.url)"
        >
          <template #media>
            <AppIcon name="logo-rss" class="color-warning" />
          </template>
        </f7-list-item>
      </f7-list>
    </template>

    <f7-block v-else class="settings-note">
      {{ $t('addFeed.hint') }}
    </f7-block>
  </f7-page>
</template>

<script>
import { f7 } from 'framework7-vue'
import { discoverFeeds } from '../utils/feedParser.js'

export default {
  name: 'AddFeedPage',

  props: {
    f7router: Object,
    f7route: Object,
    // Set when a link shared from another app looked like a feed. The URL is already
    // known, so the search runs straight away — retyping it would be absurd.
    initialUrl: {
      type: String,
      default: '',
    },
  },

  data() {
    return {
      url: this.initialUrl || '',
      loading: false,
      errorMsg: null,
      candidates: [],
    }
  },

  mounted() {
    if (this.initialUrl) this.searchFeeds()
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

    onUrlInput(event) {
      this.url = event.target.value
      this.candidates = []
      this.errorMsg = null
    },

    async searchFeeds() {
      const input = this.url.trim()
      if (!input || this.loading) return

      this.loading = true
      this.errorMsg = null
      this.candidates = []

      try {
        const found = await discoverFeeds(input)

        if (found.length === 0) {
          this.errorMsg = this.$t('addFeed.notFound')
          return
        }
        if (found.length === 1) {
          await this.addFeed(found[0].url)
          return
        }

        // A site can advertise many feeds — picking one for the user would be a guess.
        this.candidates = found
      } catch (err) {
        this.reportError(err)
      } finally {
        this.loading = false
      }
    },

    async addFeed(feedUrl) {
      this.loading = true
      this.errorMsg = null

      try {
        await this.$store.addFeed(feedUrl)
        this.f7router.back()
      } catch (err) {
        this.candidates = []
        this.reportError(err)
      } finally {
        this.loading = false
      }
    },

    reportError(err) {
      console.error('[AddFeed] Error adding feed:', err)
      if (err.message === 'not_found') {
        this.errorMsg = this.$t('addFeed.notFound')
      } else if (err.message === 'already_added') {
        this.errorMsg = this.$t('addFeed.alreadyAdded')
      } else {
        this.errorMsg = import.meta.env.DEV
          ? `${this.$t('addFeed.error')}: ${err.message}`
          : this.$t('addFeed.error')
      }
    },
  },
}
</script>
