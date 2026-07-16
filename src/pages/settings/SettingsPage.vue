<template>
  <f7-page name="settings" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-list strong inset dividers class="settings-index">
      <f7-list-item
        v-for="section in sections"
        :key="section.route"
        :link="section.route"
        :title="$t(`settings.sections.${section.id}.title`)"
        :footer="$t(`settings.sections.${section.id}.subtitle`)"
      >
        <template #media>
          <AppIcon :name="section.icon" :class="section.color" />
        </template>
      </f7-list-item>
    </f7-list>

    <f7-block-footer class="settings-about">
      <strong>Quell Feed</strong> · {{ appVersion }}<br />
      {{ $t('settings.tagline') }}
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'

export default {
  name: 'SettingsPage',

  mixins: [hidesTabbar],

  data() {
    return {
      appVersion: __APP_VERSION__,
      sections: [
        { id: 'appearance', route: '/settings/appearance/', icon: 'color-palette-outline', color: 'color-accent' },
        { id: 'feeds', route: '/settings/feeds/', icon: 'logo-rss', color: 'color-warning' },
        { id: 'sync', route: '/settings/sync/', icon: 'cloud-outline', color: 'color-success' },
        { id: 'paywall', route: '/settings/paywall/', icon: 'lock-open-outline', color: 'color-warning' },
        { id: 'ai', route: '/settings/ai/', icon: 'sparkles-outline', color: 'color-accent' },
        { id: 'data', route: '/settings/data/', icon: 'swap-vertical-outline', color: 'color-success' },
        { id: 'advanced', route: '/settings/advanced/', icon: 'construct-outline', color: 'color-muted' },
      ],
    }
  },
}
</script>
