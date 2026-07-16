import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMediaSession } from '../src/utils/mediaSession.js'

/**
 * jsdom has neither navigator.mediaSession nor a working <audio> — which is exactly
 * the "platform cannot do this" case the helper has to survive, so both are tested:
 * once with the API stubbed in, once without it.
 */
function stubMediaSession() {
  const session = {
    metadata: null,
    playbackState: 'none',
    handlers: {},
    setActionHandler(action, handler) {
      this.handlers[action] = handler
    },
  }

  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true })
  window.MediaMetadata = class {
    constructor(init) {
      Object.assign(this, init)
    }
  }

  return session
}

function stubAudio() {
  const element = { play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() }
  window.Audio = vi.fn(() => element)
  return element
}

const blobs = []

beforeEach(() => {
  blobs.length = 0
  URL.createObjectURL = vi.fn(blob => {
    blobs.push(blob)
    return 'blob:silent'
  })
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  delete navigator.mediaSession
  delete window.MediaMetadata
})

describe('createMediaSession', () => {
  it('degrades to nothing when the platform has no media session', async () => {
    const media = createMediaSession({ onPlay: vi.fn() })

    await expect(media.enable({ title: 'Titel' })).resolves.toBe(false)
    expect(() => media.setPlaybackState('playing')).not.toThrow()
    expect(() => media.release()).not.toThrow()
  })

  it('carries the article into the notification and wires its buttons back', async () => {
    const session = stubMediaSession()
    const audio = stubAudio()
    const handlers = { onPlay: vi.fn(), onPause: vi.fn(), onStop: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn() }

    const media = createMediaSession(handlers)
    await expect(media.enable({ title: 'Der Artikel', artist: 'Die Quelle', artwork: 'https://x/y.jpg' })).resolves.toBe(true)

    expect(session.metadata).toMatchObject({
      title: 'Der Artikel',
      artist: 'Die Quelle',
      artwork: [{ src: 'https://x/y.jpg' }],
    })

    session.handlers.play()
    session.handlers.pause()
    session.handlers.nexttrack()
    session.handlers.previoustrack()
    session.handlers.stop()

    expect(handlers.onPlay).toHaveBeenCalled()
    expect(handlers.onPause).toHaveBeenCalled()
    expect(handlers.onNext).toHaveBeenCalled()
    expect(handlers.onPrevious).toHaveBeenCalled()
    expect(handlers.onStop).toHaveBeenCalled()

    expect(audio.play).toHaveBeenCalled()
    expect(audio.loop).toBe(true)
  })

  it('plays a carrier long enough for Android to show a notification at all', async () => {
    stubMediaSession()
    stubAudio()

    await createMediaSession({}).enable({ title: 'x' })

    // Chrome ignores media shorter than ~5 s for the media session, so the silent
    // loop is 10 s: 8000 mono 8-bit samples per second plus the 44 byte WAV header.
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('audio/wav')
    expect(blobs[0].size).toBe(44 + 10 * 8000)
  })

  it('keeps the carrier running while paused, so the notification survives', async () => {
    stubMediaSession()
    const audio = stubAudio()

    const media = createMediaSession({})
    await media.enable({ title: 'x' })

    media.setPlaybackState('paused')
    expect(navigator.mediaSession.playbackState).toBe('paused')
    expect(audio.pause).not.toHaveBeenCalled() // ← a paused carrier means no play button
  })

  it('takes the notification down with it on release', async () => {
    const session = stubMediaSession()
    const audio = stubAudio()

    const media = createMediaSession({ onPlay: vi.fn() })
    await media.enable({ title: 'x' })
    media.release()

    expect(audio.pause).toHaveBeenCalled()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    expect(session.handlers.play).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:silent')
  })

  it('survives an artwork URL the platform refuses', async () => {
    const session = stubMediaSession()
    stubAudio()
    window.MediaMetadata = class {
      constructor() {
        throw new TypeError('bad artwork')
      }
    }

    const media = createMediaSession({})
    await expect(media.enable({ title: 'x', artwork: 'not a url' })).resolves.toBe(true)
    expect(session.metadata).toBeNull()
  })
})
