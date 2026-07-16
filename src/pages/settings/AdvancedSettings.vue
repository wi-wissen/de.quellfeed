<template>
  <f7-page name="settings-advanced" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.advanced.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-block-title>{{ $t('settings.domainConfigs') }}</f7-block-title>
    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('settings.domainConfigBaseUrl')"
        :placeholder="$t('settings.domainConfigPlaceholder')"
        :value="domainConfigBaseUrl"
        clear-button
        @input="domainConfigBaseUrl = $event.target.value"
        @keyup.enter="saveDomainConfigBaseUrl"
        @blur="saveDomainConfigBaseUrl"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>
      <!-- Clearing the URL turns remote configs off entirely (a feature) — which makes
           the way BACK essential: nobody remembers the default address by heart. -->
      <f7-list-item
        v-if="showReset"
        class="settings-action-item"
        :title="$t('settings.domainConfigReset')"
        :footer="defaultConfigBaseUrl"
        @click="resetDomainConfigBaseUrl"
      >
        <template #media>
          <AppIcon name="refresh-outline" class="color-accent" />
        </template>
      </f7-list-item>
    </f7-list>
    <f7-block-footer>{{ $t('settings.domainConfigHint') }}</f7-block-footer>

    <f7-block-title>{{ $t('settings.cache') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item class="settings-action-item" :title="$t('settings.clearCache')" @click="clearCaches">
        <template #media>
          <AppIcon name="trash-bin-outline" class="color-danger" />
        </template>
      </f7-list-item>
    </f7-list>
    <f7-block-footer>{{ $t('settings.cacheHint') }}</f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { getDefaultConfigBaseUrl } from '../../utils/domainConfig.js'

export default {
  name: 'AdvancedSettings',

  mixins: [hidesTabbar],

  data() {
    return {
      domainConfigBaseUrl: '',
    }
  },

  computed: {
    defaultConfigBaseUrl() {
      return getDefaultConfigBaseUrl()
    },
    showReset() {
      return (
        Boolean(this.defaultConfigBaseUrl) &&
        String(this.domainConfigBaseUrl || '').trim().replace(/\/+$/, '') !== this.defaultConfigBaseUrl
      )
    },
  },

  methods: {
    onPageInExtra() {
      this.domainConfigBaseUrl = this.$store.settings.domainConfigBaseUrl
    },
    onPageOutExtra() {
      this.saveDomainConfigBaseUrl()
    },
    async saveDomainConfigBaseUrl() {
      const normalized = String(this.domainConfigBaseUrl || '').trim().replace(/\/+$/, '')
      if (normalized === this.$store.settings.domainConfigBaseUrl) return

      this.domainConfigBaseUrl = normalized
      await this.$store.setDomainConfigBaseUrl(normalized)
    },
    async resetDomainConfigBaseUrl() {
      this.domainConfigBaseUrl = this.defaultConfigBaseUrl
      await this.saveDomainConfigBaseUrl()
    },
    async clearCaches() {
      const confirmed = await new Promise(resolve => {
        this.$f7.dialog.confirm(
          this.$t('settings.clearCacheConfirm'),
          this.$t('settings.clearCache'),
          () => resolve(true),
          () => resolve(false),
        )
      })
      if (!confirmed) return

      const { clearedArticleCount, clearedDomainConfigCount } = await this.$store.clearCaches()
      this.$f7.toast.show({
        text: this.$t('settings.clearCacheDone', {
          articles: clearedArticleCount,
          configs: clearedDomainConfigCount,
        }),
        closeTimeout: 2500,
      })
    },
  },
}
</script>
