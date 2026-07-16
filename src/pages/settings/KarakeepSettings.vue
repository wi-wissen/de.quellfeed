<template>
  <f7-page name="settings-karakeep" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.karakeep.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- Every string on this page comes from settings.karakeep.*. It used to borrow the
         labels, toasts and errors from settings.sync.*, which is the WebDAV section — so
         an unconfigured KaraKeep server said "No WebDAV server set up yet", and a rejected
         API key was reported as a rejected username and password. -->
    <f7-block-header>{{ $t('settings.karakeep.hint') }}</f7-block-header>

    <!-- Said up front: KaraKeep's `archived` used to carry the read state; now it is the
         archive, and the read state stays local (WebDAV still syncs it). -->
    <f7-block-header class="settings-warning">
      {{ $t('settings.karakeep.noReadState') }}
    </f7-block-header>

    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('settings.karakeep.baseUrl')"
        :placeholder="$t('settings.karakeep.baseUrlPlaceholder')"
        :value="settings.baseUrl"
        clear-button
        @input="onChange('baseUrl', $event.target.value)"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <SecretInput
        :label="$t('settings.karakeep.apiKey')"
        :value="settings.apiKey"
        @input="onChange('apiKey', $event)"
      ></SecretInput>
    </f7-list>

    <f7-block-footer>{{ $t('settings.karakeep.apiKeyHint') }}</f7-block-footer>

    <f7-list strong inset dividers>
      <f7-list-item>
        <span>{{ $t('settings.karakeep.favouritesOnly') }}</span>
        <f7-toggle
          :checked="settings.favouritesOnly"
          @change="onChange('favouritesOnly', $event.target.checked)"
        ></f7-toggle>
      </f7-list-item>
      <f7-list-item>
        <span>{{ $t('settings.karakeep.enabled') }}</span>
        <f7-toggle
          :checked="settings.enabled"
          @change="onChange('enabled', $event.target.checked)"
        ></f7-toggle>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.karakeep.lastSync')"
        :after="lastSyncLabel"
      ></f7-list-item>
    </f7-list>

    <f7-block-footer>{{ $t('settings.karakeep.favouritesOnlyHint') }}</f7-block-footer>

    <f7-block class="sync-actions">
      <f7-button outline large :disabled="busy || !configured" @click="test">
        {{ $t('settings.karakeep.test') }}
      </f7-button>
      <f7-button fill large :disabled="busy || !configured" @click="syncNow">
        <f7-preloader v-if="syncing" color="white" size="20"></f7-preloader>
        <span v-else>{{ $t('settings.karakeep.syncNow') }}</span>
      </f7-button>
    </f7-block>

    <f7-block-footer v-if="!configured">
      {{ $t('settings.karakeep.notConfigured') }}
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { isKarakeepConfigured, testKarakeepConnection } from '../../utils/karakeep.js'
import { SYNC_ERROR_KEYS } from '../../utils/syncErrors.js'

export default {
  name: 'KarakeepSettings',

  mixins: [hidesTabbar],

  data() {
    return { testing: false, syncing: false }
  },

  computed: {
    settings() {
      return this.$store.settings.karakeep
    },
    configured() {
      return isKarakeepConfigured(this.settings)
    },
    busy() {
      return this.testing || this.syncing
    },
    lastSyncLabel() {
      const iso = this.settings.lastSync
      if (!iso) return this.$t('settings.karakeep.never')
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    },
  },

  methods: {
    async onChange(key, value) {
      await this.$store.setKarakeepSettings({ [key]: value })
    },
    async test() {
      this.testing = true
      try {
        await testKarakeepConnection(this.settings)
        this.toast(this.$t('settings.karakeep.testOk'))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.testing = false
      }
    },
    async syncNow() {
      this.syncing = true
      try {
        const { pushed, pulled } = await this.$store.syncWithKarakeep()
        this.toast(this.$t('settings.karakeep.done', { pushed, pulled }))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.syncing = false
      }
    },
    reportError(err) {
      console.error('[KaraKeep] failed:', err.message)
      this.toast(this.$t(`settings.karakeep.errors.${SYNC_ERROR_KEYS[err.message] || 'serverError'}`))
    },
    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 3000 })
    },
  },
}
</script>
