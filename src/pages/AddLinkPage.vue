<template>
  <f7-page
    name="add-link"
    @page:beforein="onPageIn"
    @page:beforeout="onPageOut"
  >
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('addLink.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('addLink.label')"
        :placeholder="$t('addLink.placeholder')"
        :value="url"
        clear-button
        @input="url = $event.target.value"
        @keyup.enter="addLink"
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
        @click="addLink"
      >
        <f7-preloader v-if="loading" color="white"></f7-preloader>
        <span v-else>{{ $t('addLink.add') }}</span>
      </f7-button>
    </f7-block>

    <f7-block v-if="loading" class="settings-note">
      {{ $t('addLink.loading') }}
    </f7-block>

    <f7-block v-else-if="errorMsg" class="text-color-red">
      {{ errorMsg }}
    </f7-block>

    <f7-block v-else class="settings-note">
      {{ $t('addLink.hint') }}
    </f7-block>
  </f7-page>
</template>

<script>
import { f7 } from 'framework7-vue'

export default {
  name: 'AddLinkPage',

  props: {
    f7router: Object,
    f7route: Object,
  },

  data() {
    return {
      url: '',
      loading: false,
      errorMsg: null,
    }
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

    async addLink() {
      const input = this.url.trim()
      if (!input || this.loading) return

      this.loading = true
      this.errorMsg = null

      try {
        const article = await this.$store.addLink(input)
        this.f7router.back()
        f7.toast.show({
          text: this.$t('addLink.added', { title: article.title }),
          closeTimeout: 2500,
        })
      } catch (err) {
        console.error('[AddLink] Error adding link:', err)
        if (err.message === 'invalid_url') {
          this.errorMsg = this.$t('addLink.invalidUrl')
        } else if (err.message === 'already_added') {
          this.errorMsg = this.$t('addLink.alreadyAdded')
        } else {
          this.errorMsg = import.meta.env.DEV
            ? `${this.$t('addLink.error')}: ${err.message}`
            : this.$t('addLink.error')
        }
      } finally {
        this.loading = false
      }
    },
  },
}
</script>
