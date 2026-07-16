<template>
  <f7-page name="settings-paywall" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.paywall.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-block-header>{{ $t('settings.paywall.hint') }}</f7-block-header>

    <f7-block v-if="!supported" strong inset class="settings-empty">
      {{ $t('settings.paywall.unsupported') }}
    </f7-block>

    <template v-else>
      <f7-list strong inset dividers form>
        <f7-list-input
          type="url"
          outline
          floating-label
          :label="$t('settings.paywall.loginUrl')"
          :placeholder="$t('settings.paywall.loginUrlPlaceholder')"
          :value="loginUrl"
          clear-button
          @input="loginUrl = $event.target.value"
          @keyup.enter="addSite"
          inputmode="url"
          autocapitalize="off"
          autocorrect="off"
        ></f7-list-input>
      </f7-list>

      <f7-block>
        <f7-button fill large :disabled="!loginUrl.trim()" @click="addSite">
          {{ $t('settings.paywall.add') }}
        </f7-button>
      </f7-block>

      <!-- Skipping this costs you the session on the next app start — a caution, not a
           footnote, and styled apart from the neutral ones. -->
      <f7-block-footer class="settings-warning">
        {{ $t('settings.paywall.stayLoggedIn') }}
      </f7-block-footer>

      <f7-block-title>{{ $t('settings.paywall.sites') }}</f7-block-title>

      <f7-block v-if="sites.length === 0" strong inset class="settings-empty">
        {{ $t('settings.paywall.noSites') }}
      </f7-block>

      <f7-list v-else strong inset dividers>
        <f7-list-item
          v-for="site in sites"
          :key="site.domain"
          :title="site.domain"
          :footer="lastLoginLabel(site)"
        >
          <template #media>
            <AppIcon name="lock-open-outline" class="color-accent" />
          </template>
          <template #after>
            <f7-link
              class="feed-delete-link"
              :aria-label="$t('settings.paywall.signIn')"
              @click.stop="openLogin(site)"
            >
              <AppIcon name="log-in-outline" class="color-accent" />
            </f7-link>
            <f7-link
              class="feed-delete-link"
              :aria-label="$t('settings.paywall.remove')"
              @click.stop="removeSite(site)"
            >
              <AppIcon name="trash-bin-outline" class="color-danger" />
            </f7-link>
          </template>
        </f7-list-item>
      </f7-list>
    </template>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import {
  isPaywallSupported,
  createPaywallSite,
  openLoginBrowser,
  clearSessionFor,
} from '../../utils/paywall.js'

export default {
  name: 'PaywallSettings',

  mixins: [hidesTabbar],

  data() {
    return {
      loginUrl: '',
      supported: isPaywallSupported(),
    }
  },

  computed: {
    sites() {
      return this.$store.settings.paywall.sites
    },
  },

  methods: {
    // Deliberately NOT a "logged in" state: a newspaper sets cookies for anonymous
    // visitors too, so there is no honest way to verify a subscription session from
    // here. This list is what the user told us, and it says so.
    lastLoginLabel(site) {
      if (!site.lastLoginAt) return this.$t('settings.paywall.neverSignedIn')
      return this.$t('settings.paywall.lastSignIn', {
        date: new Date(site.lastLoginAt).toLocaleDateString(),
      })
    },

    async addSite() {
      const input = this.loginUrl.trim()
      if (!input) return

      let site
      try {
        site = createPaywallSite({ loginUrl: input })
      } catch {
        this.toast(this.$t('settings.paywall.invalidUrl'))
        return
      }

      if (this.sites.some(s => s.domain === site.domain)) {
        this.toast(this.$t('settings.paywall.alreadyAdded'))
        return
      }

      await this.$store.setPaywallSites([...this.sites, site])
      this.loginUrl = ''
      await this.openLogin(site)
    },

    async openLogin(site) {
      try {
        await openLoginBrowser({
          url: site.loginUrl,
          title: site.domain,
          onClose: () => this.markSignedIn(site),
        })
      } catch (err) {
        console.error('[Paywall] login browser failed:', err?.message)
        this.toast(this.$t('settings.paywall.unsupported'))
      }
    },

    async markSignedIn(site) {
      const sites = this.sites.map(s =>
        s.domain === site.domain ? { ...s, lastLoginAt: Date.now() } : s,
      )
      await this.$store.setPaywallSites(sites)
    },

    async removeSite(site) {
      const confirmed = await new Promise(resolve => {
        this.$f7.dialog.confirm(
          this.$t('settings.paywall.removeConfirm', { domain: site.domain }),
          this.$t('settings.paywall.remove'),
          () => resolve(true),
          () => resolve(false),
        )
      })
      if (!confirmed) return

      // Removing the entry must also drop the cookies — otherwise the session
      // silently outlives the thing the user just deleted.
      await clearSessionFor(site.domain)
      await this.$store.setPaywallSites(this.sites.filter(s => s.domain !== site.domain))
    },

    toast(text) {
      this.$f7.toast.show({ text, closeTimeout: 3000 })
    },
  },
}
</script>
