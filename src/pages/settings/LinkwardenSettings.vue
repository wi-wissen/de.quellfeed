<template>
  <f7-page name="settings-linkwarden" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.linkwarden.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- Every string on this page comes from settings.linkwarden.*. It used to borrow the
         labels, toasts and errors from settings.sync.*, which is the WebDAV section — so
         an unconfigured Linkwarden server said "No WebDAV server set up yet", and a
         rejected access token was reported as a rejected username and password. -->
    <f7-block-header>{{ $t('settings.linkwarden.hint') }}</f7-block-header>

    <!-- Said up front, not buried: Linkwarden cannot store a publication date and has
         no read state. Finding that out after syncing 300 articles would be worse. -->
    <f7-block-header class="settings-warning">
      <p>{{ $t('settings.linkwarden.noDate') }}</p>
      <p>{{ $t('settings.linkwarden.noReadState') }}</p>
      <p>{{ $t('settings.linkwarden.cloudPlan') }}</p>
    </f7-block-header>

    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('settings.linkwarden.baseUrl')"
        :placeholder="$t('settings.linkwarden.baseUrlPlaceholder')"
        :value="settings.baseUrl"
        clear-button
        @input="onChange('baseUrl', $event.target.value)"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <SecretInput
        :label="$t('settings.linkwarden.apiKey')"
        :value="settings.apiKey"
        @input="onChange('apiKey', $event)"
      ></SecretInput>

      <f7-list-input
        type="text"
        outline
        floating-label
        :label="$t('settings.linkwarden.collection')"
        :value="settings.collectionName"
        clear-button
        @input="onChange('collectionName', $event.target.value)"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>
    </f7-list>

    <f7-block-footer>
      <p>{{ $t('settings.linkwarden.apiKeyHint') }}</p>
      <p>{{ $t('settings.linkwarden.collectionHint') }}</p>
      <p>{{ $t('settings.linkwarden.archiveCollection', { name: settings.collectionName || 'Quell Feed' }) }}</p>
    </f7-block-footer>

    <f7-list strong inset dividers>
      <f7-list-item>
        <span>{{ $t('settings.linkwarden.enabled') }}</span>
        <f7-toggle
          :checked="settings.enabled"
          @change="onChange('enabled', $event.target.checked)"
        ></f7-toggle>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.linkwarden.lastSync')"
        :after="lastSyncLabel"
      ></f7-list-item>
    </f7-list>

    <f7-block class="sync-actions">
      <f7-button outline large :disabled="busy || !configured" @click="test">
        {{ $t('settings.linkwarden.test') }}
      </f7-button>
      <f7-button fill large :disabled="busy || !configured" @click="syncNow">
        <f7-preloader v-if="syncing" color="white" size="20"></f7-preloader>
        <span v-else>{{ $t('settings.linkwarden.syncNow') }}</span>
      </f7-button>
    </f7-block>

    <f7-block-footer v-if="!configured">
      {{ $t('settings.linkwarden.notConfigured') }}
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { isLinkwardenConfigured, testLinkwardenConnection } from '../../utils/linkwarden.js'
import { SYNC_ERROR_KEYS } from '../../utils/syncErrors.js'

export default {
  name: 'LinkwardenSettings',

  mixins: [hidesTabbar],

  data() {
    return { testing: false, syncing: false }
  },

  computed: {
    settings() {
      return this.$store.settings.linkwarden
    },
    configured() {
      return isLinkwardenConfigured(this.settings)
    },
    busy() {
      return this.testing || this.syncing
    },
    lastSyncLabel() {
      const iso = this.settings.lastSync
      if (!iso) return this.$t('settings.linkwarden.never')
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    },
  },

  methods: {
    async onChange(key, value) {
      await this.$store.setLinkwardenSettings({ [key]: value })
    },
    async test() {
      this.testing = true
      try {
        await testLinkwardenConnection(this.settings)
        this.toast(this.$t('settings.linkwarden.testOk'))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.testing = false
      }
    },
    async syncNow() {
      this.syncing = true
      try {
        const { pushed, pulled } = await this.$store.syncWithLinkwarden()
        this.toast(this.$t('settings.linkwarden.done', { pushed, pulled }))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.syncing = false
      }
    },
    reportError(err) {
      console.error('[Linkwarden] failed:', err.message)
      this.toast(this.$t(`settings.linkwarden.errors.${SYNC_ERROR_KEYS[err.message] || 'serverError'}`))
    },
    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 3000 })
    },
  },
}
</script>
