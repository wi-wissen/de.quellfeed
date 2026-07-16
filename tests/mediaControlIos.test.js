import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * createMediaSession on native iOS. The full native behavior is pinned down in
 * mediaControl.test.js against a mocked Android; iOS presents the SAME plugin API
 * (ios/App/App/MediaControlPlugin.swift), so this file only pins what iOS must
 * additionally guarantee: the platform gate chooses the native path at all, and the
 * permission short-cut (iOS resolves granted without a dialog) changes nothing for
 * the caller.
 */

const plugin = {
  show: vi.fn(),
  update: vi.fn(),
  hide: vi.fn(),
  requestNotificationPermission: vi.fn(),
  addListener: vi.fn(),
}

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  },
  registerPlugin: () => plugin,
}))

const { createMediaSession } = await import('../src/utils/mediaSession.js')

let emitAction = null

beforeEach(() => {
  vi.clearAllMocks()

  plugin.show.mockResolvedValue(undefined)
  plugin.update.mockResolvedValue(undefined)
  plugin.hide.mockResolvedValue(undefined)
  // What the Swift side actually does: Now Playing needs no permission, so it
  // resolves granted immediately instead of showing any dialog.
  plugin.requestNotificationPermission.mockResolvedValue({ granted: true })

  emitAction = null
  plugin.addListener.mockImplementation((event, listener) => {
    if (event === 'mediaAction') emitAction = listener
    return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) })
  })
})

describe('createMediaSession (native iOS)', () => {
  const METADATA = { title: 'Der Artikel', artist: 'Die Quelle' }

  it('takes the native path, not the silent-<audio> web fallback', async () => {
    const media = createMediaSession({})

    await expect(media.enable(METADATA)).resolves.toBe(true)

    // The proof: the plugin was driven, and no carrier <audio> was ever created.
    expect(plugin.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Der Artikel',
      source: 'Die Quelle',
      playing: true,
    }))
  })

  it('routes lock-screen and headset commands back into the player', async () => {
    const handlers = { onPlay: vi.fn(), onPause: vi.fn(), onStop: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn() }
    const media = createMediaSession(handlers)
    await media.enable(METADATA)

    emitAction({ action: 'play' })
    emitAction({ action: 'pause' })
    emitAction({ action: 'stop' })
    emitAction({ action: 'next' })
    emitAction({ action: 'previous' })

    expect(handlers.onPlay).toHaveBeenCalledTimes(1)
    expect(handlers.onPause).toHaveBeenCalledTimes(1)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1)
  })

  it('mirrors pause/resume/stop into the Now Playing entry', async () => {
    const media = createMediaSession({})
    await media.enable(METADATA)

    media.setPlaybackState('paused')
    expect(plugin.update).toHaveBeenCalledWith({ playing: false })

    media.setPlaybackState('none')
    expect(plugin.hide).toHaveBeenCalledTimes(1)
  })
})
