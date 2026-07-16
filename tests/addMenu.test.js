import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addForTab, openAddMenu, bindLongPress } from '../src/utils/addMenu.js'
import { f7 } from 'framework7-vue'

vi.mock('framework7-vue', () => ({
  f7: {
    actions: { create: vi.fn() },
    params: { touch: { tapHold: false, tapHoldDelay: 750 } },
  },
}))

/** Stand-in for vue-i18n's t(): echoes the key, so nothing can be mistaken for a literal. */
const t = key => `[[${key}]]`

function stubRouter() {
  return { navigate: vi.fn() }
}

/** The button groups handed to the single f7.actions.create() call. */
function menuGroups() {
  return f7.actions.create.mock.calls[0][0].buttons
}

beforeEach(() => {
  vi.clearAllMocks()
  f7.params.touch.tapHold = false
  f7.params.touch.tapHoldDelay = 750
  f7.actions.create.mockReturnValue({ open: vi.fn() })
})

describe('addForTab', () => {
  it('subscribes to a feed from the feed tab', () => {
    const router = stubRouter()
    addForTab(router, 'feed')
    expect(router.navigate).toHaveBeenCalledWith('/add-feed/')
  })

  it('saves a link from the saved tab', () => {
    const router = stubRouter()
    addForTab(router, 'saved')
    expect(router.navigate).toHaveBeenCalledWith('/add-link/')
  })

  // The archive holds saved articles, so its "+" means the same thing as in Saved.
  it('saves a link from the archive tab', () => {
    const router = stubRouter()
    addForTab(router, 'archive')
    expect(router.navigate).toHaveBeenCalledWith('/add-link/')
  })

  // The feed tab is the main view, so an unknown tab lands there rather than nowhere.
  it('falls back to the feed flow for an unknown tab', () => {
    const router = stubRouter()
    addForTab(router, undefined)
    expect(router.navigate).toHaveBeenCalledWith('/add-feed/')
  })
})

describe('openAddMenu', () => {
  it('offers both ways in, from either tab', () => {
    openAddMenu(stubRouter(), t, 'feed')

    const texts = menuGroups()[0].map(b => b.text)
    expect(texts).toContain('[[add.feed]]')
    expect(texts).toContain('[[add.link]]')
  })

  it('marks the current tab’s own action as the default', () => {
    openAddMenu(stubRouter(), t, 'saved')

    const [, feedButton, linkButton] = menuGroups()[0]
    expect(feedButton.bold).toBe(false)
    expect(linkButton.bold).toBe(true)
  })

  it('treats the archive tab like the saved tab', () => {
    openAddMenu(stubRouter(), t, 'archive')

    const [, feedButton, linkButton] = menuGroups()[0]
    expect(feedButton.bold).toBe(false)
    expect(linkButton.bold).toBe(true)
  })

  it('routes each button to its page', () => {
    const router = stubRouter()
    openAddMenu(router, t, 'feed')

    const [, feedButton, linkButton] = menuGroups()[0]

    feedButton.onClick()
    expect(router.navigate).toHaveBeenCalledWith('/add-feed/')

    linkButton.onClick()
    expect(router.navigate).toHaveBeenCalledWith('/add-link/')
  })
})

describe('bindLongPress', () => {
  it('arms Framework7’s taphold, which ships disabled', () => {
    bindLongPress(document.createElement('div'), vi.fn())

    expect(f7.params.touch.tapHold).toBe(true)
    expect(f7.params.touch.tapHoldDelay).toBe(500)
  })

  it('leaves an explicitly configured taphold alone', () => {
    f7.params.touch.tapHold = true
    f7.params.touch.tapHoldDelay = 750

    bindLongPress(document.createElement('div'), vi.fn())

    expect(f7.params.touch.tapHoldDelay).toBe(750)
  })

  it('fires on Framework7’s taphold — the touch route', () => {
    const el = document.createElement('div')
    const handler = vi.fn()
    bindLongPress(el, handler)

    el.dispatchEvent(new CustomEvent('taphold', { bubbles: true }))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  // Mouse and keyboard never see a taphold: F7 only binds its touch handlers on a touch
  // device. contextmenu is the desktop gesture for the same menu.
  it('fires on contextmenu — the mouse and keyboard route — and suppresses the native menu', () => {
    const el = document.createElement('div')
    const handler = vi.fn()
    bindLongPress(el, handler)

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(event)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('stops listening when unbound', () => {
    const el = document.createElement('div')
    const handler = vi.fn()

    bindLongPress(el, handler)()

    el.dispatchEvent(new CustomEvent('taphold', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(handler).not.toHaveBeenCalled()
  })

  it('survives a missing element', () => {
    expect(() => bindLongPress(null, vi.fn())()).not.toThrow()
  })
})
