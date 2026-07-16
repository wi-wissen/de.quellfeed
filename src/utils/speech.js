// Reads an article aloud through the OS speech engine.
//
// ── What the plugin actually gives us (@capacitor-community/text-to-speech 5.1.0)
// speak(), stop(), getSupportedLanguages(), getSupportedVoices(),
// isLanguageSupported(), openInstall() (Android only) and exactly one event,
// 'onRangeStart' (word-level highlighting; Android + iOS only, the web
// implementation never emits it).
//
// ── There is no pause()/resume(), so we build one ────────────────────────────
// The plugin has none, and neither does Android's TextToSpeech. What it does have
// is `onRangeStart`, which reports the character range of the word being spoken
// *inside the string we handed to speak()*. So we remember that offset, stop the
// engine, and on resume speak the REST of the current chunk (`text.slice(offset)`)
// before continuing with the queue. Audibly this restarts at a word boundary, not
// mid-word — the one seam is that a stopped engine cuts the current word off.
//
// ── Why the pause between paragraphs was so long ─────────────────────────────
// Every speak() is a bridge call *and* a fresh synthesis request: the engine only
// starts working once it has the string, so the gap between two chunks is a full
// engine start-up latency. QueueStrategy.Add (5.1.0) appends to the engine's own
// queue instead of flushing it, so the next chunk can be handed over WHILE the
// current one is still playing and the engine plays them back to back. We keep one
// chunk queued ahead — see LOOKAHEAD.
//
// The web plugin cannot do this: its speak() begins with `await this.stop()`, so a
// second call would cancel the first. Hence the look-ahead is native-only.
//
// ── Why stop() cannot simply await speak() ──────────────────────────────────
// speak() is limited in length (Android's TextToSpeech.getMaxSpeechInputLength()
// is 4000 characters and the plugin hands our string straight to it), so a whole
// article has to be spoken as a *queue* of utterances, awaited one by one.
//
// The trap is stop(). On Android the plugin does:
//
//     public void stop() { tts.stop(); requests.clear(); }
//
// `requests` holds the pending PluginCall — clearing it drops the call on the
// floor without resolving OR rejecting it. So the JS promise of the utterance
// that was playing NEVER settles. An `await speak(...)` loop would hang there
// forever. On the web the same call rejects instead (speechSynthesis.cancel()
// fires 'error'/'end' on the utterance).
//
// Hence: every speak() is raced against a stop gate, and every step re-checks a
// session token. Calling TextToSpeech.stop() alone would not stop the queue.

import { TextToSpeech, QueueStrategy } from '@capacitor-community/text-to-speech'
import { Capacitor } from '@capacitor/core'
import { detectArticleLanguage } from './ai.js'
import { extractArticleText, splitIntoUtterances, MAX_UTTERANCE_CHARS } from './articleText.js'

// The engine wants a BCP 47 tag, the app only knows 'de' | 'en'.
export const LOCALE_BY_LANGUAGE = { de: 'de-DE', en: 'en-US' }

// iOS: 'ambient' (the plugin default) stops the moment the screen locks, which is
// useless for an article you want read to you. 'playback' keeps going in the
// background. Ignored on Android and web.
const DEFAULT_CATEGORY = 'playback'

// One chunk queued ahead is enough to hide the engine's start-up latency, and it
// keeps `onRangeStart` unambiguous: the events of chunk n+1 can only arrive after
// the engine has reported chunk n done, and that is exactly when the loop below has
// already moved on to n+1.
const LOOKAHEAD = 1

function nativeLookahead() {
  return Capacitor.isNativePlatform?.() ? LOOKAHEAD : 0
}

// The plugin reports "cannot speak this" in three different shapes:
//   • CapacitorException code UNAVAILABLE / UNIMPLEMENTED (web without
//     speechSynthesis, openInstall() on non-Android),
//   • Android's call.unavailable("Not yet initialized or not available…"),
//   • Android's ERROR_UNSUPPORTED_LANGUAGE — the literal string
//     "This language is not supported.", which speak() rejects with when the
//     locale is not in getSupportedLanguages().
function isUnavailableError(error) {
  const code = error?.code || ''
  if (code === 'UNAVAILABLE' || code === 'UNIMPLEMENTED') return true
  return /not available|not supported|not implemented|unsupported|unimplemented/i.test(error?.message || '')
}

function normalizeError(error) {
  if (error instanceof Error && (error.message === 'unsupported' || error.message === 'no_content')) {
    return error
  }
  if (isUnavailableError(error)) return new Error('unsupported')

  const failure = new Error('speech_failed')
  failure.cause = error
  return failure
}

/**
 * BCP 47 tags the engine can actually speak.
 *
 * An empty list is NOT the same as "nothing is supported": in a browser
 * speechSynthesis.getVoices() routinely returns [] until the voices have loaded
 * asynchronously, and the plugin derives its language list from exactly that
 * call. Callers must treat [] as "unknown, trust the engine".
 *
 * @throws {Error} `unsupported` when the platform has no speech engine at all
 */
export async function getSupportedLocales() {
  try {
    const result = await TextToSpeech.getSupportedLanguages()
    return Array.isArray(result?.languages) ? result.languages : []
  } catch (error) {
    if (isUnavailableError(error)) throw new Error('unsupported')
    return []
  }
}

/** True when this device can speak at all. */
export async function isSpeechAvailable() {
  try {
    await getSupportedLocales()
    return true
  } catch {
    return false
  }
}

function matchLocale(preferred, language, supported) {
  const wanted = preferred.toLowerCase()

  const exact = supported.find(tag => String(tag).toLowerCase() === wanted)
  if (exact) return exact

  // 'de-DE' missing but 'de-AT' present — still German, still right.
  const sameLanguage = supported.find(tag => String(tag).toLowerCase().split(/[-_]/)[0] === language)
  if (sameLanguage) return sameLanguage

  // Nothing in the article's language. English is the better guess than silence,
  // and Android *rejects* speak() outright for an unsupported tag
  // (ERROR_UNSUPPORTED_LANGUAGE), so we must hand it something from the list.
  const english = supported.find(tag => String(tag).toLowerCase().startsWith('en'))
  return english || supported[0]
}

/**
 * Picks the locale to speak in: the article's own language where we can tell,
 * the UI language otherwise, checked against what the engine actually has.
 *
 * @param {string} text the text about to be spoken
 * @param {string} [uiLanguage] app language ('de' | 'en'), used as the fallback
 *   when the article's language cannot be detected
 * @returns {Promise<string>} a BCP 47 tag the engine accepts
 * @throws {Error} `unsupported`
 */
export async function resolveSpeechLocale(text, uiLanguage = 'en') {
  const fallback = uiLanguage === 'de' ? 'de' : 'en'
  const language = detectArticleLanguage(text, fallback)
  const preferred = LOCALE_BY_LANGUAGE[language] || LOCALE_BY_LANGUAGE.en

  const supported = await getSupportedLocales()
  if (supported.length === 0) return preferred // voices not loaded yet — let the engine decide

  return matchLocale(preferred, language, supported)
}

function toText(input, options) {
  if (typeof input === 'string') return input.trim()
  if (!input || typeof input !== 'object') return ''

  const title = String(input.title || '').trim()
  const body = typeof input.text === 'string' && input.text.trim()
    ? input.text.trim()
    : extractArticleText(input.html || '', options)

  // The title is its own paragraph, so the engine pauses after it.
  return [title, body].filter(Boolean).join('\n\n')
}

/**
 * Turns the input into the two layers the controller plays on:
 *
 *   • units  — what the *reader* sees: one paragraph, one entry. Progress, the
 *     highlight and "read from here" all count in units.
 *   • chunks — what the *engine* gets: a unit that exceeds the engine's input limit
 *     is broken up further, so one unit can produce several chunks.
 *
 * Only a unit longer than the limit is ever split, so for a normal article the two
 * layers are the same list.
 */
function prepare(input, options) {
  const limit = Math.max(1, Math.floor(Number(options.maxChars ?? MAX_UTTERANCE_CHARS) || MAX_UTTERANCE_CHARS))

  const units = Array.isArray(input?.units)
    ? input.units
      .map(unit => String(typeof unit === 'string' ? unit : unit?.text || '').trim())
      .filter(Boolean)
    : splitIntoUtterances(toText(input, options), limit)

  if (units.length === 0) throw new Error('no_content')

  const chunks = []
  units.forEach((text, unit) => {
    const parts = text.length <= limit ? [text] : splitIntoUtterances(text, limit)
    parts.forEach(part => chunks.push({ unit, text: part }))
  })

  if (chunks.length === 0) throw new Error('no_content')

  return { units, chunks, text: units.join('\n\n') }
}

/**
 * The player behind the reading view: a queue of paragraphs with play, pause,
 * resume, stop and seek. Hold ONE per app (the store is the natural place) so that
 * leaving the reading view can stop whatever is being read.
 *
 * @param {{
 *   onStart?: (total: number) => void,
 *   onProgress?: (index: number, total: number) => void,
 *   onStateChange?: (state: {speaking: boolean, paused: boolean}) => void,
 *   onEnd?: () => void,
 *   onError?: (error: Error) => void,
 * }} [handlers] `onProgress` fires *before* each unit, so `index` is the paragraph
 *   being spoken right now (0-based) — that is what a progress bar and the
 *   highlight want. `onEnd` fires on natural completion only, never on stop():
 *   stop() is caller-initiated, so the caller already knows.
 */
export function createSpeechController(handlers = {}) {
  // Bumped by stop(), pause() and every (re)start. Every step of the queue compares
  // against it, which is what actually cancels the queue — TextToSpeech.stop()
  // only silences the utterance that is playing right now.
  let session = 0
  let speaking = false
  let paused = false
  let stopGate = null

  let units = []
  let chunks = []
  let chunkIndex = 0
  let chunkOffset = 0 // characters of chunks[chunkIndex].text already spoken
  let locale = null
  let playOptions = {}
  let rangeListener = null
  let tracking = false
  // Where each queued chunk started inside its unit. A resumed chunk is spoken as a
  // slice, so `onRangeStart` reports offsets into that slice, not into the chunk.
  let rangeBases = []

  function state() {
    return { speaking, paused }
  }

  function currentUnit() {
    return chunks[chunkIndex]?.unit ?? 0
  }

  function openStopGate() {
    let release
    const promise = new Promise(resolve => { release = resolve })
    stopGate = { promise, release }
    return stopGate
  }

  function invalidate() {
    session += 1
    speaking = false
    // Unblocks the utterance whose promise Android will never settle.
    if (stopGate) {
      stopGate.release()
      stopGate = null
    }
  }

  async function silence() {
    try {
      await TextToSpeech.stop()
    } catch {
      // Nothing was playing, or this platform has no engine. Either way there is
      // nothing left to stop.
    }
  }

  // The only thing that tells us how far into a chunk the engine has got. Without
  // it, "resume" could only mean "start this paragraph over".
  //
  // Whether the events come AT ALL is up to the device's TTS engine: Android only
  // calls UtteranceProgressListener.onRangeStart when the engine supplies timing
  // information (Google's does for its local voices; several vendor engines and
  // network voices never do). On such a device the offset stays 0 and resume falls
  // back to the start of the paragraph — same as on the web. The one-shot log below
  // is what makes that diagnosable from chrome://inspect on a real device.
  //
  // addListener() is async, so the flag — not `rangeListener` — is what keeps two
  // quick starts (tap a paragraph, tap another) from registering two listeners.
  let sawRangeEvent = false

  async function trackRanges() {
    if (typeof TextToSpeech.addListener !== 'function') return
    if (tracking) return
    tracking = true

    try {
      rangeListener = await TextToSpeech.addListener('onRangeStart', info => {
        // Events in flight when pause() hits still sharpen the resume point, so
        // `paused` passes. Only a dead controller (stopped, ended) ignores them —
        // there is no position left for them to update.
        if (!speaking && !paused) return
        if (!sawRangeEvent) {
          sawRangeEvent = true
          console.info('[speech] engine reports word positions — resume will be word-accurate')
        }
        chunkOffset = (rangeBases[chunkIndex] || 0) + (Number(info?.start) || 0)
      })
    } catch {
      tracking = false // no event support (web) — resume then restarts the paragraph
    }
  }

  async function releaseRanges() {
    const handle = rangeListener
    rangeListener = null
    tracking = false
    try {
      await handle?.remove()
    } catch {}
  }

  async function stop() {
    const wasActive = speaking || paused
    invalidate()
    paused = false
    units = []
    chunks = []
    chunkIndex = 0
    chunkOffset = 0
    handlers.onStateChange?.(state())

    if (!wasActive) return
    await releaseRanges()
    await silence()
  }

  /** Silences the engine but keeps the position, so resume() can pick it up. */
  async function pause() {
    if (!speaking) return
    invalidate()
    paused = true
    handlers.onStateChange?.(state())
    await silence()
  }

  /**
   * Starts a run without waiting for it to finish. speak() is the one entry point
   * that resolves only when the article is fully read (its callers await exactly
   * that); a resume or a seek comes from a button press and must hand control back
   * at once. Failures are already reported through onError.
   */
  function kick(fromChunk, fromOffset) {
    start(fromChunk, fromOffset).catch(() => {})
  }

  function resume() {
    if (!paused || chunks.length === 0) return
    kick(chunkIndex, chunkOffset)
  }

  /**
   * Runs the queue from one chunk/offset on. Bumps the session first, so whatever
   * was playing is abandoned; the engine itself is flushed by the first speak(),
   * which is the only one in the run that uses QueueStrategy.Flush.
   */
  async function start(fromChunk, fromOffset) {
    invalidate()
    const mySession = session
    const gate = openStopGate()

    const startChunk = Math.min(Math.max(fromChunk, 0), chunks.length - 1)
    const startOffset = Math.max(fromOffset, 0)

    paused = false
    speaking = true
    chunkIndex = startChunk
    chunkOffset = startOffset
    rangeBases = []

    const lookahead = Number.isInteger(playOptions.lookahead) ? playOptions.lookahead : nativeLookahead()
    const pending = []
    let queued = 0

    await trackRanges()
    if (mySession !== session) return

    const enqueue = (index, offset) => {
      if (index < 0 || index >= chunks.length || pending[index]) return

      const text = offset > 0 ? chunks[index].text.slice(offset) : chunks[index].text
      rangeBases[index] = offset

      const call = TextToSpeech.speak({
        text,
        lang: locale,
        rate: playOptions.rate ?? 1.0,
        pitch: playOptions.pitch ?? 1.0,
        volume: playOptions.volume ?? 1.0,
        category: playOptions.category ?? DEFAULT_CATEGORY,
        // The first call of a run must clear whatever the engine still holds; every
        // later one appends, which is what removes the gap between paragraphs.
        queueStrategy: queued === 0 ? QueueStrategy.Flush : QueueStrategy.Add,
        ...(typeof playOptions.voice === 'number' ? { voice: playOptions.voice } : {}),
      })

      // On the web a stop() makes this reject *after* the race below has already
      // moved on. Without a handler that would surface as an unhandled rejection.
      call.catch(() => {})
      pending[index] = call
      queued += 1
    }

    handlers.onStateChange?.(state())

    let reportedUnit = -1

    try {
      for (let index = startChunk; index < chunks.length; index += 1) {
        if (mySession !== session) return

        enqueue(index, index === startChunk ? startOffset : 0)
        for (let ahead = index + 1; ahead <= index + lookahead; ahead += 1) enqueue(ahead, 0)

        chunkIndex = index
        chunkOffset = rangeBases[index] || 0

        const unit = chunks[index].unit
        if (unit !== reportedUnit) {
          reportedUnit = unit
          handlers.onProgress?.(unit, units.length)
        }

        await Promise.race([pending[index], gate.promise])
        if (mySession !== session) return
      }

      speaking = false
      stopGate = null
      chunkIndex = 0
      chunkOffset = 0
      handlers.onStateChange?.(state())
      await releaseRanges()
      handlers.onEnd?.()
    } catch (error) {
      if (mySession !== session) return // stop() raced the rejection — not a failure

      speaking = false
      stopGate = null
      handlers.onStateChange?.(state())
      await releaseRanges()

      const failure = normalizeError(error)
      handlers.onError?.(failure)
      throw failure
    }
  }

  /**
   * @param {string|{html?: string, text?: string, title?: string, units?: Array<string|{text: string}>}} input
   *   `units` is the reading view's shape: one entry per paragraph of the article,
   *   so that progress, highlight and "read from here" line up with what is on screen.
   * @param {object} [options] `maxChars`, `language`, `rate`, `pitch`, `volume`,
   *   `voice`, `category`, `startAt` (unit index), `lookahead`
   */
  async function speak(input, options = {}) {
    let prepared
    try {
      prepared = prepare(input, options)
    } catch (error) {
      const failure = normalizeError(error)
      handlers.onError?.(failure)
      throw failure
    }

    await stop()
    const mySession = session

    let resolved
    try {
      resolved = await resolveSpeechLocale(prepared.text, options.language)
    } catch (error) {
      const failure = normalizeError(error)
      handlers.onError?.(failure)
      throw failure
    }
    if (mySession !== session) return // stopped while we were asking the engine

    units = prepared.units
    chunks = prepared.chunks
    locale = resolved
    playOptions = { ...options }

    handlers.onStart?.(units.length)

    const from = chunks.findIndex(chunk => chunk.unit === (options.startAt ?? 0))
    return start(from < 0 ? 0 : from, 0)
  }

  /** Jumps to a paragraph and reads on from there — the "tap a paragraph" gesture. */
  async function seekTo(unit) {
    if (chunks.length === 0) return

    // Past the last paragraph is the end of the article, not an error.
    if (unit >= units.length) {
      const wasActive = speaking || paused
      await stop()
      if (wasActive) handlers.onEnd?.()
      return
    }

    const from = chunks.findIndex(chunk => chunk.unit === Math.max(0, unit))
    if (from < 0) return

    kick(from, 0)
  }

  return {
    speak,
    stop,
    pause,
    resume,
    seekTo,
    next: () => seekTo(currentUnit() + 1),
    previous: () => seekTo(currentUnit() - 1),
    isSpeaking: () => speaking,
    isPaused: () => paused,
    getProgress: () => ({
      index: chunks.length === 0 ? 0 : currentUnit(),
      total: units.length,
    }),
  }
}
