// Puts the read-aloud player into the system's media notification — the thing you
// see when you pull the status bar down, and on the lock screen.
//
// ── Two implementations behind one interface ─────────────────────────────────
// On native platforms this drives our own MediaControlPlugin — one per platform,
// same API and same 'mediaAction' event vocabulary (Android: MediaSessionCompat +
// MediaStyle notification; iOS: MPNowPlayingInfoCenter + MPRemoteCommandCenter).
// The web-standard route below it, navigator.mediaSession fed by a silent looping
// <audio>, demonstrably shows NOTHING inside the Android WebView on real devices;
// it stays in as the browser fallback because it is handy when debugging in a
// desktop browser.
//
// Whichever side is active, the interface is the same:
//   enable(metadata)         → bring the controls up (call from a user gesture:
//                              the web carrier needs one; native does not care)
//   setMetadata(metadata)    → new title/source
//   setPlaybackState(state)  → 'playing' | 'paused' | 'none' ('none' hides)
//   release()                → tear everything down
//
// Every call degrades quietly: no permission, no platform support, no carrier —
// the app keeps reading aloud and only loses the notification.

import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Our own plugin, implemented once per platform behind one JS name:
 * android/app/src/main/java/de/quellfeed/MediaControlPlugin.java and
 * ios/App/App/MediaControlPlugin.swift.
 */
const MediaControl = registerPlugin('MediaControl')

/**
 * @param {{
 *   onPlay?: () => void,
 *   onPause?: () => void,
 *   onStop?: () => void,
 *   onNext?: () => void,
 *   onPrevious?: () => void,
 * }} handlers what the notification's buttons do
 * @returns {{
 *   enable: (metadata?: object) => Promise<boolean>,
 *   setMetadata: (metadata: object) => void,
 *   setPlaybackState: (state: 'playing'|'paused'|'none') => void,
 *   release: () => void,
 * }} `enable` reports whether the system controls actually came up — false means
 *   there will be no notification, which is not an error the user needs to hear about.
 */
export function createMediaSession(handlers = {}) {
  // Spelled out rather than just isNativePlatform(): a future platform must not
  // silently claim a native plugin it does not ship.
  const platform = Capacitor.getPlatform?.()
  if (Capacitor.isNativePlatform?.() && (platform === 'android' || platform === 'ios')) {
    return createNativeSession(handlers)
  }
  return createWebSession(handlers)
}

// ── Native (Android + iOS): MediaControlPlugin ───────────────────────────────

function createNativeSession(handlers) {
  const actionMap = {
    play: handlers.onPlay,
    pause: handlers.onPause,
    stop: handlers.onStop,
    next: handlers.onNext,
    previous: handlers.onPrevious,
  }

  let listener = null
  let subscribing = null
  // Asked once per session object, i.e. once per article view. Android answers a
  // second request after a denial silently anyway; there is no dialog to spam.
  let permission = null
  let current = { title: '', source: '', labels: undefined }
  let shown = false

  function ensurePermission() {
    if (!permission) {
      permission = MediaControl.requestNotificationPermission()
        .then(result => Boolean(result?.granted))
        .catch(() => false)
    }
    return permission
  }

  // addListener is async; the memoized promise keeps two quick enables from
  // registering the buttons twice.
  function ensureListener() {
    if (!subscribing) {
      subscribing = MediaControl.addListener('mediaAction', event => {
        actionMap[event?.action]?.()
      })
        .then(handle => { listener = handle })
        .catch(() => { subscribing = null })
    }
    return subscribing
  }

  async function enable(metadata = {}) {
    current = {
      title: String(metadata.title || ''),
      source: String(metadata.artist || metadata.source || ''),
      // The article's cover — album art on the system card. The plugin fetches and
      // downsamples it off the main thread; an empty string means "no art", never an error.
      imageUrl: String(metadata.artwork || ''),
      labels: metadata.labels,
    }

    try {
      // Denied is not an error: the plugin then simply posts no card, while the
      // MediaSession (headset buttons, lock screen on some launchers) still works.
      await ensurePermission()
      await ensureListener()
      await MediaControl.show({ ...current, playing: true })
      shown = true
      return true
    } catch {
      return false
    }
  }

  function setMetadata(metadata = {}) {
    current = {
      title: String(metadata.title || ''),
      source: String(metadata.artist || metadata.source || ''),
      imageUrl: String(metadata.artwork || current.imageUrl || ''),
      labels: metadata.labels ?? current.labels,
    }
    if (shown) MediaControl.show({ ...current, playing: true }).catch(() => {})
  }

  function setPlaybackState(state) {
    if (!shown) return
    if (state === 'none') {
      // Stopped is gone: a dead player must not keep a remote control around.
      shown = false
      MediaControl.hide().catch(() => {})
      return
    }
    MediaControl.update({ playing: state === 'playing' }).catch(() => {})
  }

  function release() {
    shown = false
    MediaControl.hide().catch(() => {})

    const handle = listener
    listener = null
    subscribing = null
    handle?.remove?.().catch?.(() => {})
  }

  return { enable, setMetadata, setPlaybackState, release }
}

// ── Web fallback: navigator.mediaSession over a silent carrier ───────────────
//
// Android shows a media notification for the app that currently *plays audio* and
// has a MediaSession. The TTS engine plays our article in ITS OWN process, so the
// page is silent and no session appears. The workaround is to give the page
// something to play: a silent, looping <audio>. Chrome then creates a MediaSession
// and navigator.mediaSession lets us fill it. Two Chrome rules to know:
//   • media shorter than ~5 seconds gets no notification — hence a 10 second loop,
//   • play() needs a user gesture — hence enable() from the play button's click.

const LOOP_SECONDS = 10
const SAMPLE_RATE = 8000

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

/**
 * A silent WAV as a Blob. Generated instead of shipped: 80 kB of zeros has no place
 * in the bundle, and this costs a millisecond once per article.
 */
function silentLoop() {
  const samples = LOOP_SECONDS * SAMPLE_RATE
  const buffer = new ArrayBuffer(44 + samples)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE, true) // byte rate
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples, true)

  // Silence in unsigned 8-bit PCM is 128, not 0 — a buffer of zeros would be a DC
  // offset, i.e. a click and then a constant pull on the speaker.
  new Uint8Array(buffer, 44).fill(128)

  return new Blob([buffer], { type: 'audio/wav' })
}

const ACTIONS = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack']

function createWebSession(handlers) {
  const session = typeof navigator !== 'undefined' ? navigator.mediaSession : null

  let audio = null
  let objectUrl = null

  function setMetadata(metadata = {}) {
    if (!session || typeof window.MediaMetadata !== 'function') return

    try {
      session.metadata = new window.MediaMetadata({
        title: String(metadata.title || ''),
        artist: String(metadata.artist || ''),
        album: String(metadata.album || ''),
        artwork: metadata.artwork ? [{ src: metadata.artwork }] : [],
      })
    } catch {
      // A malformed artwork URL must not take the player down with it.
    }
  }

  function setPlaybackState(state) {
    if (!session) return
    try {
      session.playbackState = state
    } catch {}

    // The carrier has to keep running while we are paused, or the browser drops the
    // notification and the user cannot press play again from it.
    if (audio && state === 'none') audio.pause()
  }

  function bindActions() {
    if (!session || typeof session.setActionHandler !== 'function') return

    const map = {
      play: handlers.onPlay,
      pause: handlers.onPause,
      stop: handlers.onStop,
      nexttrack: handlers.onNext,
      previoustrack: handlers.onPrevious,
    }

    ACTIONS.forEach(action => {
      try {
        session.setActionHandler(action, map[action] ? () => map[action]() : null)
      } catch {
        // Not every action is supported everywhere — an unsupported one throws.
      }
    })
  }

  async function enable(metadata) {
    if (!session) return false

    setMetadata(metadata || {})
    bindActions()

    try {
      if (!audio) {
        objectUrl = URL.createObjectURL(silentLoop())
        audio = new Audio(objectUrl)
        audio.loop = true
        // NOT muted and not volume 0: a muted element does not count as playing
        // audio, and then the whole point of it is gone. It is silence, not mute.
        audio.volume = 1
        audio.preload = 'auto'
      }
      await audio.play()
      return true
    } catch {
      return false // no gesture, or the platform refused — degrade to no notification
    }
  }

  function release() {
    if (session && typeof session.setActionHandler === 'function') {
      ACTIONS.forEach(action => {
        try {
          session.setActionHandler(action, null)
        } catch {}
      })
    }
    if (session) {
      try {
        session.playbackState = 'none'
        session.metadata = null
      } catch {}
    }

    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio = null
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  return { enable, setMetadata, setPlaybackState, release }
}
