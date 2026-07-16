<template>
  <f7-page name="settings-webdav" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sync.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- settings.sync.* IS the WebDAV section — this is the only page that may use it.
         The block-title that used to sit here just repeated the navbar. -->
    <f7-block-header>{{ $t('settings.sync.hint') }}</f7-block-header>

    <f7-list strong inset dividers form>
      <f7-list-input
        type="url"
        outline
        floating-label
        :label="$t('settings.sync.serverUrl')"
        :placeholder="$t('settings.sync.serverUrlPlaceholder')"
        :value="webdav.baseUrl"
        clear-button
        @input="onChange('baseUrl', $event.target.value)"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <f7-list-input
        type="text"
        outline
        floating-label
        :label="$t('settings.sync.username')"
        :value="webdav.username"
        clear-button
        @input="onChange('username', $event.target.value)"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <SecretInput
        :label="$t('settings.sync.password')"
        :value="webdav.password"
        @input="onChange('password', $event)"
      ></SecretInput>

      <f7-list-input
        type="text"
        outline
        floating-label
        :label="$t('settings.sync.path')"
        :value="webdav.path"
        clear-button
        @input="onChange('path', $event.target.value)"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>
    </f7-list>

    <!-- The password lands unencrypted on the device — that is a caution, not a footnote,
         so it is styled as one. The folder rule is the neutral note next to it. -->
    <f7-block-footer class="settings-warning">
      {{ $t('settings.sync.passwordHint') }}
    </f7-block-footer>
    <f7-block-footer>{{ $t('settings.sync.pathHint') }}</f7-block-footer>

    <f7-list strong inset dividers>
      <f7-list-item>
        <span>{{ $t('settings.sync.enabled') }}</span>
        <f7-toggle
          :checked="webdav.enabled"
          @change="onChange('enabled', $event.target.checked)"
        ></f7-toggle>
      </f7-list-item>
      <f7-list-item
        class="settings-action-item"
        :title="$t('settings.sync.lastSync')"
        :after="lastSyncLabel"
      ></f7-list-item>
    </f7-list>

    <f7-block class="sync-actions">
      <f7-button outline large :disabled="busy" @click="testConnection">
        {{ $t('settings.sync.test') }}
      </f7-button>
      <f7-button fill large :disabled="busy || !configured" @click="syncNow">
        <f7-preloader v-if="syncing" color="white" size="20"></f7-preloader>
        <span v-else>{{ $t('settings.sync.syncNow') }}</span>
      </f7-button>
    </f7-block>

    <f7-block-footer v-if="!configured">
      {{ $t('settings.sync.notConfigured') }}
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { isWebdavConfigured, testWebdavConnection } from '../../utils/sync.js'
import { SYNC_ERROR_KEYS as ERROR_KEYS } from '../../utils/syncErrors.js'

export default {
  name: 'WebdavSettings',

  mixins: [hidesTabbar],

  data() {
    return {
      testing: false,
      syncing: false,
    }
  },

  computed: {
    webdav() {
      return this.$store.settings.webdav
    },
    configured() {
      return isWebdavConfigured(this.webdav)
    },
    busy() {
      return this.testing || this.syncing
    },
    lastSyncLabel() {
      const iso = this.webdav.lastSync
      if (!iso) return this.$t('settings.sync.never')
      return new Date(iso).toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    },
  },

  methods: {
    async onChange(key, value) {
      await this.$store.setWebdavSettings({ [key]: value })
    },

    async testConnection() {
      this.testing = true
      try {
        await testWebdavConnection(this.webdav)
        this.toast(this.$t('settings.sync.testOk'))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.testing = false
      }
    },

    async syncNow() {
      this.syncing = true
      try {
        const { pushed, pulled } = await this.$store.syncWithWebdav()
        this.toast(this.$t('settings.sync.done', { pushed, pulled }))
      } catch (err) {
        this.reportError(err)
      } finally {
        this.syncing = false
      }
    },

    reportError(err) {
      console.error('[Sync] failed:', err.message)
      const key = ERROR_KEYS[err.message] || 'serverError'
      this.toast(this.$t(`settings.sync.errors.${key}`))
    },
    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 3000 })
    },
  },
}
</script>
