<template>
  <f7-page name="settings-sync" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.sync.title') }}</f7-nav-title>
    </f7-navbar>

    <!-- The subtitle of each row is the whole point of this page: you are choosing between
         three targets that are NOT interchangeable, and each row says in one sentence what
         it does and what it cannot do. Linkwarden's missing publication date and read state
         belong here, not only on the Linkwarden page you reach after deciding. -->
    <f7-list strong inset dividers class="sync-targets">
      <f7-list-item
        v-for="target in targets"
        :key="target.id"
        :link="target.route"
        :title="$t(`settings.syncIndex.${target.id}.title`)"
        :footer="$t(`settings.syncIndex.${target.id}.subtitle`)"
        :after="target.enabled ? $t('settings.syncIndex.on') : ''"
      >
        <template #media>
          <AppIcon :name="target.icon" :class="target.enabled ? 'color-success' : 'color-muted'" />
        </template>
      </f7-list-item>
    </f7-list>

    <f7-block-footer>
      <p>{{ $t('settings.syncIndex.difference') }}</p>
      <p>{{ $t('settings.syncIndex.hint') }}</p>
    </f7-block-footer>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'

export default {
  name: 'SyncSettings',

  mixins: [hidesTabbar],

  computed: {
    targets() {
      return [
        {
          id: 'webdav',
          route: '/settings/sync/webdav/',
          icon: 'cloud-outline',
          enabled: this.$store.settings.webdav.enabled,
        },
        {
          id: 'karakeep',
          route: '/settings/sync/karakeep/',
          icon: 'bookmark-outline',
          enabled: this.$store.settings.karakeep.enabled,
        },
        {
          id: 'linkwarden',
          route: '/settings/sync/linkwarden/',
          icon: 'link-outline',
          enabled: this.$store.settings.linkwarden.enabled,
        },
      ]
    },
  },
}
</script>
