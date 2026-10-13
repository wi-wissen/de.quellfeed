<template>
  <f7-page name="settings-instapaper" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.instapaper.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- Every string on this page comes from settings.instapaper.*. -->
    <f7-block-header>{{ $t('settings.instapaper.hint') }}</f7-block-header>

    <f7-block-header class="settings-warning">
      <p>{{ $t('settings.instapaper.noReadState') }}</p>
      <p>{{ $t('settings.instapaper.ownApp') }}</p>
    </f7-block-header>

    <f7-list strong inset dividers form>
      <SecretInput
        :label="$t('settings.instapaper.accessToken')"
        :value="settings.accessToken"
        @input="onChange('accessToken', $event)"
      ></SecretInput>
    </f7-list>

    <f7-block-footer>{{ $t('settings.instapaper.accessTokenHint') }}</f7-block-footer>

    <f7-list strong inset dividers>
      <f7-list-item>
        <span>{{ $t('settings.instapaper.enabled') }}</span>
        <f7-toggle
          :checked="settings.enabled"
          @change="onChange('enabled', $event.target.checked)"
        ></f7-toggle>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.instapaper.lastSync')"
        :after="lastSyncLabel"
      ></f7-list-item>
    </f7-list>

    <f7-block class="sync-actions">
      <f7-button outline large :disabled="busy || !configured" @click="test">
        {{ $t('settings.instapaper.test') }}
      </f7-button>
      <f7-button fill large :disabled="busy || !configured" @click="syncNow">
        <f7-preloader v-if="syncing" color="white" size="20"></f7-preloader>
        <span v-else>{{ $t('settings.instapaper.syncNow') }}</span>
      </f7-button>
    </f7-block>

    <f7-block-footer v-if="!configured">
      {{ $t('settings.instapaper.notConfigured') }}
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { isInstapaperConfigured, testInstapaperConnection } from '../../utils/instapaper.js'
import { SYNC_ERROR_KEYS } from '../../utils/syncErrors.js'

export default {
  name: 'InstapaperSettings',

  mixins: [hidesTabbar],

  data() {
    return { testing: false, syncing: false }
  },

  computed: {
    settings() {
      return this.$store.settings.instapaper
    },
    configured() {
      return isInstapaperConfigured(this.settings)
    },
    busy() {
      return this.testing || this.syncing
    },
    lastSyncLabel() {
      const iso = this.settings.lastSync
      if (!iso) return this.$t('settings.instapaper.never')
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    },
  },

  methods: {
    async onChange(key, value) {
      await this.$store.setInstapaperSettings({ [key]: value })
    },
    async test() {
      this.testing = true
      try {
        await testInstapaperConnection(this.settings)
        this.toast(this.$t('settings.instapaper.testOk'))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.testing = false
      }
    },
    async syncNow() {
      this.syncing = true
      try {
        const { pushed, pulled } = await this.$store.syncWithInstapaper()
        this.toast(this.$t('settings.instapaper.done', { pushed, pulled }))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.syncing = false
      }
    },
    reportError(err) {
      console.error('[Instapaper] failed:', err.message)
      this.toast(this.$t(`settings.instapaper.errors.${SYNC_ERROR_KEYS[err.message] || 'serverError'}`))
    },
    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 3000 })
    },
  },
}
</script>
