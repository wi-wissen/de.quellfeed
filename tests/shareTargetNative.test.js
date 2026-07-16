import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The platform gate and the plugin contract of shareTarget.js — the parts that
 * shareTarget.test.js (which keeps @capacitor/core real, i.e. "web") cannot reach.
 *
 * Both native platforms ship a hand-written ShareIntent plugin with the SAME API
 * (ShareIntentPlugin.java / ShareIntentPlugin.swift), which is exactly what these
 * tests pin down: the JS side must not care which one it is talking to.
 */

const state = { platform: 'web' }

const plugin = {
  consume: vi.fn(),
  consumePending: vi.fn(),
  addListener: vi.fn(),
}

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => state.platform,
    isNativePlatform: () => state.platform !== 'web',
  },
  registerPlugin: () => plugin,
}))

const { isShareTargetSupported, consumePendingShares, listenForSharedLinks } =
  await import('../src/utils/shareTarget.js')

beforeEach(() => {
  vi.clearAllMocks()
  plugin.consume.mockResolvedValue({ text: null })
  plugin.consumePending.mockResolvedValue({ urls: [] })
  plugin.addListener.mockResolvedValue({ remove: vi.fn() })
})

describe('isShareTargetSupported', () => {
  it('says yes on both native platforms — they ship the same plugin API', () => {
    state.platform = 'android'
    expect(isShareTargetSupported()).toBe(true)
    state.platform = 'ios'
    expect(isShareTargetSupported()).toBe(true)
  })

  it('says no on the web — there is no share sheet to be a target of', () => {
    state.platform = 'web'
    expect(isShareTargetSupported()).toBe(false)
  })
})

describe('consumePendingShares (iOS)', () => {
  beforeEach(() => {
    state.platform = 'ios'
  })

  it('drains the queue the share extension filled', async () => {
    plugin.consumePending.mockResolvedValue({ urls: ['https://a.example/1', 'https://b.example/2'] })

    await expect(consumePendingShares()).resolves.toEqual([
      'https://a.example/1',
      'https://b.example/2',
    ])
  })

  it('drops junk a future native side might send', async () => {
    plugin.consumePending.mockResolvedValue({ urls: ['https://a.example/1', 42, '', null] })

    await expect(consumePendingShares()).resolves.toEqual(['https://a.example/1'])
  })

  it('turns a broken bridge into an empty day, not an error', async () => {
    plugin.consumePending.mockRejectedValue(new Error('bridge down'))

    await expect(consumePendingShares()).resolves.toEqual([])
  })

  it('does not even ask the plugin on the web', async () => {
    state.platform = 'web'

    await expect(consumePendingShares()).resolves.toEqual([])
    expect(plugin.consumePending).not.toHaveBeenCalled()
  })
})

describe('listenForSharedLinks (iOS)', () => {
  beforeEach(() => {
    state.platform = 'ios'
  })

  it('consumes a share that started the app cold, then listens for warm ones', async () => {
    plugin.consume.mockResolvedValue({ text: 'Schau mal https://example.com/feed' })
    const onShare = vi.fn()

    await listenForSharedLinks(onShare)

    expect(onShare).toHaveBeenCalledWith('https://example.com/feed', 'feed')
    expect(plugin.addListener).toHaveBeenCalledWith('shareReceived', expect.any(Function))
  })

  it('routes the shareReceived event (feed link opened the app) back through consume()', async () => {
    let emit
    plugin.addListener.mockImplementation((event, listener) => {
      emit = listener
      return Promise.resolve({ remove: vi.fn() })
    })
    const onShare = vi.fn()
    await listenForSharedLinks(onShare)

    plugin.consume.mockResolvedValue({ text: 'https://blog.example/rss' })
    await emit()

    expect(onShare).toHaveBeenCalledWith('https://blog.example/rss', 'feed')
  })

  it('stays quiet when nothing was shared — consume() resolves {text: null}', async () => {
    const onShare = vi.fn()

    await listenForSharedLinks(onShare)

    expect(onShare).not.toHaveBeenCalled()
  })
})
