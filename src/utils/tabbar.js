import { f7 } from 'framework7-vue'

/**
 * Full-screen pages sit above the tab layout, so they hide the tab bar while they
 * are open. Every such page repeated the same two lines — this is that, once.
 * Mix it in and the page:beforein / page:beforeout handlers are wired for you.
 */
export const hidesTabbar = {
  methods: {
    onPageIn() {
      const tabbar = document.querySelector('.tabbar')
      if (tabbar) f7.toolbar.hide(tabbar, false)
      this.onPageInExtra?.()
    },
    onPageOut() {
      this.onPageOutExtra?.()
      const tabbar = document.querySelector('.tabbar')
      if (tabbar) f7.toolbar.show(tabbar, false)
    },
  },
}
