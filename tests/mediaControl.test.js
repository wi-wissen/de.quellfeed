import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The NATIVE half of createMediaSession — the one that drives MediaControlPlugin
 * (android/…/MediaControlPlugin.java). The web half is covered in
 * mediaSession.test.js, where @capacitor/core stays real and reports "web".
 * Here the platform is mocked to native Android, so the module must talk to the
 * plugin instead of navigator.mediaSession.
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
    getPlatform: () => 'android',
  },
  registerPlugin: () => plugin,
}))

const { createMediaSession } = await import('../src/utils/mediaSession.js')

/** What the notification's buttons send back over the bridge. */
let emitAction = null
let removeListener = null

beforeEach(() => {
  vi.clearAllMocks()

  plugin.show.mockResolvedValue(undefined)
  plugin.update.mockResolvedValue(undefined)
  plugin.hide.mockResolvedValue(undefined)
  plugin.requestNotificationPermission.mockResolvedValue({ granted: true })

  emitAction = null
  removeListener = vi.fn().mockResolvedValue(undefined)
  plugin.addListener.mockImplementation((event, listener) => {
    if (event === 'mediaAction') emitAction = listener
    return Promise.resolve({ remove: removeListener })
  })
})

describe('createMediaSession (native Android)', () => {
  const METADATA = {
    title: 'Der Artikel',
    artist: 'Die Quelle',
    labels: { play: 'Vorlesen', pause: 'Pause', stop: 'Stopp', next: 'Weiter', previous: 'Zurück', channel: 'Vorlesen' },
  }

  it('shows the notification with title, source and the translated labels', async () => {
    const media = createMediaSession({})

    await expect(media.enable(METADATA)).resolves.toBe(true)

    expect(plugin.show).toHaveBeenCalledWith({
      title: 'Der Artikel',
      source: 'Die Quelle',
      imageUrl: '', // no artwork given — "no art" travels as the empty string
      labels: METADATA.labels,
      playing: true,
    })
  })

  it('asks for the notification permission exactly once per article', async () => {
    const media = createMediaSession({})

    // enable() runs on every press of play — the permission dialog must not.
    await media.enable(METADATA)
    await media.enable(METADATA)

    expect(plugin.requestNotificationPermission).toHaveBeenCalledTimes(1)
    expect(plugin.addListener).toHaveBeenCalledTimes(1)
  })

  it('keeps working when the permission is denied — just without nagging', async () => {
    plugin.requestNotificationPermission.mockResolvedValue({ granted: false })
    const media = createMediaSession({})

    // The plugin itself skips the card when it may not post one; JS still calls
    // show() so the MediaSession (headset buttons) stays alive.
    await expect(media.enable(METADATA)).resolves.toBe(true)
    expect(plugin.show).toHaveBeenCalled()
  })

  it('routes the notification buttons back into the player', async () => {
    const handlers = { onPlay: vi.fn(), onPause: vi.fn(), onStop: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn() }
    const media = createMediaSession(handlers)
    await media.enable(METADATA)

    emitAction({ action: 'play' })
    emitAction({ action: 'pause' })
    emitAction({ action: 'stop' })
    emitAction({ action: 'next' })
    emitAction({ action: 'previous' })
    emitAction({ action: 'does-not-exist' }) // future plugin versions must not crash us

    expect(handlers.onPlay).toHaveBeenCalledTimes(1)
    expect(handlers.onPause).toHaveBeenCalledTimes(1)
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
    expect(handlers.onNext).toHaveBeenCalledTimes(1)
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1)
  })

  it('mirrors the player state into the notification', async () => {
    const media = createMediaSession({})
    await media.enable(METADATA)

    media.setPlaybackState('paused')
    expect(plugin.update).toHaveBeenCalledWith({ playing: false })

    media.setPlaybackState('playing')
    expect(plugin.update).toHaveBeenCalledWith({ playing: true })

    media.setPlaybackState('none')
    expect(plugin.hide).toHaveBeenCalledTimes(1)

    // Hidden means gone: no further updates may resurrect the card.
    plugin.update.mockClear()
    media.setPlaybackState('playing')
    expect(plugin.update).not.toHaveBeenCalled()
  })

  it('does not touch the notification before enable()', () => {
    const media = createMediaSession({})

    media.setPlaybackState('playing')
    media.setPlaybackState('none')

    expect(plugin.update).not.toHaveBeenCalled()
    expect(plugin.hide).not.toHaveBeenCalled()
  })

  it('release() hides the card and detaches the buttons', async () => {
    const media = createMediaSession({})
    await media.enable(METADATA)

    media.release()

    expect(plugin.hide).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('a translated article updates the card in place', async () => {
    const media = createMediaSession({})
    await media.enable(METADATA)
    plugin.show.mockClear()

    media.setMetadata({ title: 'The Article', artist: 'Die Quelle' })

    expect(plugin.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'The Article',
      source: 'Die Quelle',
      labels: METADATA.labels, // the labels survive a metadata-only update
    }))
  })

  it('survives a plugin that rejects everything (broken bridge)', async () => {
    plugin.show.mockRejectedValue(new Error('bridge down'))
    plugin.requestNotificationPermission.mockRejectedValue(new Error('bridge down'))
    plugin.addListener.mockRejectedValue(new Error('bridge down'))

    const media = createMediaSession({})

    await expect(media.enable(METADATA)).resolves.toBe(false)
    expect(() => media.setPlaybackState('playing')).not.toThrow()
    expect(() => media.release()).not.toThrow()
  })
})
