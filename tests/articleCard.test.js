import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import ArticleCard from '../src/components/ArticleCard.vue'
import { shareArticle } from '../src/utils/share.js'

vi.mock('framework7-vue', () => ({
  f7: {
    actions: { create: vi.fn(() => ({ open: vi.fn(), destroy: vi.fn() })) },
    params: { touch: { tapHold: false, tapHoldDelay: 750 } },
  },
}))

vi.mock('../src/utils/share.js', () => ({
  shareArticle: vi.fn(),
}))

function article(overrides = {}) {
  return {
    id: 'a-1',
    feedId: 'f-1',
    title: 'An article',
    description: 'Its teaser',
    url: 'https://example.com/article',
    publishedAt: new Date().toISOString(),
    isRead: false,
    isSaved: false,
    isArchived: false,
    ...overrides,
  }
}

/**
 * Mounted without Framework7 — the f7 swipeout components render as plain elements,
 * which keeps the assertion honest: which button sits on which edge, and what it does.
 */
function mount(props) {
  const host = document.createElement('div')
  document.body.appendChild(host)

  const app = createApp({ render: () => h(ArticleCard, props) })
  app.config.warnHandler = () => {}
  app.config.globalProperties.$t = key => `[[${key}]]`
  app.config.globalProperties.$store = {}
  // As an unknown element, f7-list-item drops its named `inner` slot — but the card
  // body (and the unread marker on it) lives exactly there. A pass-through renderer
  // brings it into the DOM; the swipeout children keep rendering as plain elements.
  app.component('f7-list-item', {
    render() {
      return h('div', [this.$slots.default?.(), this.$slots.inner?.()])
    },
  })
  app.mount(host)

  return host
}

function leadingButton(host) {
  return host.querySelector('f7-swipeout-actions[left] f7-swipeout-button')
}

beforeEach(() => {
  vi.clearAllMocks()
})

// One verb, every list — it used to toggle read in saved/archive, but a gesture whose
// meaning depends on the tab you are in is a gesture you cannot learn. Read/unread
// lives in the hold menu.
describe('the leading swipe (swipe right) shares everywhere', () => {
  for (const [context, props] of [
    ['feed', article()],
    ['saved', article({ isSaved: true })],
    ['archive', article({ isSaved: true, isArchived: true, isRead: true })],
  ]) {
    it(`shares in the ${context}`, () => {
      const host = mount({ article: props, context })
      const button = leadingButton(host)

      expect(button.querySelector('appicon').getAttribute('name')).toBe('share-outline')

      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(shareArticle).toHaveBeenCalledTimes(1)
    })
  }
})

describe('the unread marker', () => {
  // The reading list's bar (app.css) hangs off this class — the bold title alone was
  // not readable as "unread" on a device.
  it('flags an unread card', () => {
    const host = mount({ article: article({ isSaved: true }), context: 'saved' })
    expect(host.querySelector('.article-card').classList.contains('is-unread')).toBe(true)
  })

  it('drops the flag once the article is read', () => {
    const host = mount({ article: article({ isSaved: true, isRead: true }), context: 'saved' })
    expect(host.querySelector('.article-card').classList.contains('is-unread')).toBe(false)
  })
})

describe('the trailing swipe (swipe left) stays as it was', () => {
  function trailingButton(host) {
    return host.querySelector('f7-swipeout-actions[right] f7-swipeout-button')
  }

  it('saves in the feed', () => {
    const host = mount({ article: article(), context: 'feed' })
    expect(trailingButton(host).querySelector('appicon').getAttribute('name')).toBe('bookmark-outline')
  })

  it('archives in the saved list', () => {
    const host = mount({ article: article({ isSaved: true }), context: 'saved' })
    expect(trailingButton(host).querySelector('appicon').getAttribute('name')).toBe('archive-outline')
  })

  it('restores in the archive', () => {
    const host = mount({ article: article({ isSaved: true, isArchived: true }), context: 'archive' })
    expect(trailingButton(host).querySelector('appicon').getAttribute('name')).toBe('arrow-undo-outline')
  })
})
