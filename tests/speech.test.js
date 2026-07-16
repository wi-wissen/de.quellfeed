import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TextToSpeech, QueueStrategy } from '@capacitor-community/text-to-speech'
import {
  createSpeechController,
  resolveSpeechLocale,
  getSupportedLocales,
  isSpeechAvailable,
  LOCALE_BY_LANGUAGE,
} from '../src/utils/speech.js'

vi.mock('@capacitor-community/text-to-speech', () => ({
  TextToSpeech: {
    speak: vi.fn(),
    stop: vi.fn(),
    getSupportedLanguages: vi.fn(),
    getSupportedVoices: vi.fn(),
    isLanguageSupported: vi.fn(),
    addListener: vi.fn(),
  },
  QueueStrategy: { Flush: 0, Add: 1 },
}))

/** The one event the plugin has: the word offsets of what is being spoken. */
let emitRange = null

/** A German paragraph, ~55 characters — enough stopwords for detectArticleLanguage(). */
const DE_PARAGRAPH = 'Das ist ein deutscher Satz und der Text ist nicht kurz.'

function germanArticle(paragraphs = 40) {
  return Array.from({ length: paragraphs }, () => DE_PARAGRAPH).join('\n\n')
}

/** Lets the test decide when a speak() call finishes — or that it never does. */
function deferSpeak() {
  const calls = []
  TextToSpeech.speak.mockImplementation(options => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    calls.push({ options, resolve, reject })
    return promise
  })
  return calls
}

async function waitFor(predicate, label = 'condition') {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Lets every already-queued microtask/macrotask run. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  TextToSpeech.speak.mockResolvedValue(undefined)
  TextToSpeech.stop.mockResolvedValue(undefined)
  TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: ['de-DE', 'en-US', 'fr-FR'] })

  emitRange = null
  TextToSpeech.addListener.mockImplementation((event, listener) => {
    if (event === 'onRangeStart') emitRange = listener
    return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) })
  })
})

describe('getSupportedLocales', () => {
  it('returns the tags the engine reports', async () => {
    await expect(getSupportedLocales()).resolves.toEqual(['de-DE', 'en-US', 'fr-FR'])
  })

  it('throws `unsupported` when the platform has no engine', async () => {
    const unavailable = Object.assign(new Error('SpeechSynthesis API not available in this browser.'), {
      code: 'UNAVAILABLE',
    })
    TextToSpeech.getSupportedLanguages.mockRejectedValue(unavailable)

    await expect(getSupportedLocales()).rejects.toThrow('unsupported')
    await expect(isSpeechAvailable()).resolves.toBe(false)
  })

  it('treats an empty voice list as "unknown", not as "unsupported"', async () => {
    TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: [] })
    await expect(getSupportedLocales()).resolves.toEqual([])
    await expect(isSpeechAvailable()).resolves.toBe(true)
  })
})

describe('resolveSpeechLocale', () => {
  it('speaks a German article in German', async () => {
    await expect(resolveSpeechLocale(DE_PARAGRAPH, 'en')).resolves.toBe('de-DE')
  })

  it('speaks an English article in English', async () => {
    const english = 'This is an english text and it is not a short one for the detector.'
    await expect(resolveSpeechLocale(english, 'de')).resolves.toBe('en-US')
  })

  it('falls back to the UI language when the article gives nothing away', async () => {
    await expect(resolveSpeechLocale('42', 'de')).resolves.toBe(LOCALE_BY_LANGUAGE.de)
  })

  it('falls back to another regional variant of the same language', async () => {
    TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: ['de-AT', 'en-GB'] })
    await expect(resolveSpeechLocale(DE_PARAGRAPH, 'de')).resolves.toBe('de-AT')
  })

  it('falls back to English when the language is missing entirely', async () => {
    TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: ['fr-FR', 'en-GB'] })
    await expect(resolveSpeechLocale(DE_PARAGRAPH, 'de')).resolves.toBe('en-GB')
  })

  it('falls back to whatever exists when even English is missing', async () => {
    TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: ['fr-FR'] })
    await expect(resolveSpeechLocale(DE_PARAGRAPH, 'de')).resolves.toBe('fr-FR')
  })

  it('keeps the preferred locale when the engine reports no voices yet', async () => {
    TextToSpeech.getSupportedLanguages.mockResolvedValue({ languages: [] })
    await expect(resolveSpeechLocale(DE_PARAGRAPH, 'de')).resolves.toBe('de-DE')
  })
})

describe('createSpeechController', () => {
  it('speaks a long article in several speak() calls', async () => {
    const controller = createSpeechController()

    await controller.speak(germanArticle(40), { maxChars: 200 })

    expect(TextToSpeech.speak.mock.calls.length).toBeGreaterThan(1)
    TextToSpeech.speak.mock.calls.forEach(([options]) => {
      expect(options.text.length).toBeLessThanOrEqual(200)
      expect(options.lang).toBe('de-DE')
    })
    expect(controller.isSpeaking()).toBe(false)
  })

  it('extracts the text from article HTML and skips captions', async () => {
    const controller = createSpeechController()

    await controller.speak({
      title: 'Der Titel',
      html: '<p>Der Absatz.</p><figure><img src="a.jpg" alt="ALTTEXT"><figcaption>Die Unterschrift</figcaption></figure>',
    })

    const spoken = TextToSpeech.speak.mock.calls.map(([options]) => options.text).join('\n')
    expect(spoken).toContain('Der Titel')
    expect(spoken).toContain('Der Absatz.')
    expect(spoken).not.toContain('Die Unterschrift')
    expect(spoken).not.toContain('ALTTEXT')
  })

  it('reports progress for every utterance and ends once', async () => {
    const handlers = {
      onStart: vi.fn(),
      onProgress: vi.fn(),
      onEnd: vi.fn(),
      onError: vi.fn(),
    }
    const controller = createSpeechController(handlers)

    await controller.speak(germanArticle(10), { maxChars: 120 })

    const total = TextToSpeech.speak.mock.calls.length
    expect(total).toBeGreaterThan(1)

    expect(handlers.onStart).toHaveBeenCalledTimes(1)
    expect(handlers.onStart).toHaveBeenCalledWith(total)

    expect(handlers.onProgress).toHaveBeenCalledTimes(total)
    handlers.onProgress.mock.calls.forEach(([index, reported], position) => {
      expect(index).toBe(position)
      expect(reported).toBe(total)
    })

    expect(handlers.onEnd).toHaveBeenCalledTimes(1)
    expect(handlers.onError).not.toHaveBeenCalled()
  })

  describe('stop()', () => {
    it('aborts the queue — no further speak() after a stop', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak(germanArticle(40), { maxChars: 120 })
      await waitFor(() => calls.length === 1, 'the first utterance')

      await controller.stop()

      // The web engine settles the cancelled utterance after the fact
      // (speechSynthesis.cancel() fires 'end'/'error'). That must not restart the queue.
      calls[0].resolve()
      await settle()

      expect(TextToSpeech.stop).toHaveBeenCalledTimes(1)
      expect(TextToSpeech.speak).toHaveBeenCalledTimes(1) // ← the whole point
      expect(controller.isSpeaking()).toBe(false)

      await expect(playback).resolves.toBeUndefined()
    })

    it('does not hang when the engine never settles the cancelled utterance (Android)', async () => {
      // Android's stop() does `requests.clear()` and drops the pending PluginCall:
      // the speak() promise never resolves and never rejects. The controller must
      // still come back.
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak(germanArticle(40), { maxChars: 120 })
      await waitFor(() => calls.length === 1, 'the first utterance')

      await controller.stop()

      await expect(playback).resolves.toBeUndefined()
      expect(TextToSpeech.speak).toHaveBeenCalledTimes(1)
    })

    it('swallows a rejection caused by the stop itself', async () => {
      const calls = deferSpeak()
      const handlers = { onError: vi.fn(), onEnd: vi.fn() }
      const controller = createSpeechController(handlers)

      const playback = controller.speak(germanArticle(40), { maxChars: 120 })
      await waitFor(() => calls.length === 1, 'the first utterance')

      await controller.stop()
      calls[0].reject(new Error('canceled'))
      await settle()

      await expect(playback).resolves.toBeUndefined()
      expect(handlers.onError).not.toHaveBeenCalled()
      expect(handlers.onEnd).not.toHaveBeenCalled() // stop() is not a natural end
    })

    it('is a no-op when nothing is playing', async () => {
      const controller = createSpeechController()
      await controller.stop()
      expect(TextToSpeech.stop).not.toHaveBeenCalled()
    })

    it('a second speak() replaces the first', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const first = controller.speak(germanArticle(40), { maxChars: 120 })
      await waitFor(() => calls.length === 1, 'the first utterance')

      const second = controller.speak('Ein ganz kurzer neuer Text.', { maxChars: 120 })
      await waitFor(() => calls.length === 2, 'the replacing utterance')

      calls[0].resolve() // the old one finishes late — it must not resume
      calls[1].resolve()
      await settle()

      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()
      expect(TextToSpeech.speak).toHaveBeenCalledTimes(2)
      expect(calls[1].options.text).toBe('Ein ganz kurzer neuer Text.')
    })
  })

  describe('errors', () => {
    it('throws `no_content` for empty text, without calling speak()', async () => {
      const handlers = { onError: vi.fn() }
      const controller = createSpeechController(handlers)

      await expect(controller.speak('')).rejects.toThrow('no_content')
      await expect(controller.speak('   \n\n ')).rejects.toThrow('no_content')
      await expect(controller.speak({ html: '' })).rejects.toThrow('no_content')
      await expect(controller.speak({ html: '<img src="a.jpg" alt="nur ein Bild">' })).rejects.toThrow('no_content')
      await expect(controller.speak(null)).rejects.toThrow('no_content')

      expect(TextToSpeech.speak).not.toHaveBeenCalled()
    })

    it('throws `unsupported` when the platform has no engine', async () => {
      const unavailable = Object.assign(new Error('SpeechSynthesis API not available in this browser.'), {
        code: 'UNAVAILABLE',
      })
      TextToSpeech.getSupportedLanguages.mockRejectedValue(unavailable)

      const handlers = { onError: vi.fn() }
      const controller = createSpeechController(handlers)

      await expect(controller.speak(DE_PARAGRAPH)).rejects.toThrow('unsupported')
      expect(TextToSpeech.speak).not.toHaveBeenCalled()
      expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'unsupported' }))
      expect(controller.isSpeaking()).toBe(false)
    })

    it('reports a failing utterance as `speech_failed`', async () => {
      TextToSpeech.speak.mockRejectedValue(new Error('Failed to read text.'))

      const handlers = { onError: vi.fn(), onEnd: vi.fn() }
      const controller = createSpeechController(handlers)

      await expect(controller.speak(DE_PARAGRAPH)).rejects.toThrow('speech_failed')
      expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'speech_failed' }))
      expect(handlers.onEnd).not.toHaveBeenCalled()
      expect(controller.isSpeaking()).toBe(false)
    })

    it('maps an unsupported language rejection to `unsupported`', async () => {
      TextToSpeech.speak.mockRejectedValue(new Error('This language is not supported.'))
      const controller = createSpeechController()

      await expect(controller.speak(DE_PARAGRAPH)).rejects.toThrow('unsupported')
    })
  })

  it('passes rate, pitch, volume and the iOS playback category through', async () => {
    const controller = createSpeechController()

    await controller.speak(DE_PARAGRAPH, { rate: 1.4, pitch: 0.9, volume: 0.8 })

    expect(TextToSpeech.speak).toHaveBeenCalledWith(expect.objectContaining({
      rate: 1.4,
      pitch: 0.9,
      volume: 0.8,
      category: 'playback',
    }))
  })

  it('exposes progress for the UI', async () => {
    const calls = deferSpeak()
    const controller = createSpeechController()

    expect(controller.isSpeaking()).toBe(false)
    expect(controller.getProgress()).toEqual({ index: 0, total: 0 })

    const playback = controller.speak(germanArticle(10), { maxChars: 120 })
    await waitFor(() => calls.length === 1, 'the first utterance')

    expect(controller.isSpeaking()).toBe(true)
    expect(controller.getProgress().total).toBeGreaterThan(1)
    expect(controller.getProgress().index).toBe(0)

    calls[0].resolve()
    await waitFor(() => calls.length === 2, 'the second utterance')
    expect(controller.getProgress().index).toBe(1)

    await controller.stop()
    await playback
  })

  describe('units', () => {
    const UNITS = [
      'Der erste Absatz des Artikels und er ist nicht kurz.',
      'Der zweite Absatz des Artikels und auch der ist es nicht.',
      'Der dritte Absatz des Artikels, damit es genug davon gibt.',
    ]

    it('speaks one paragraph per unit and counts progress in paragraphs', async () => {
      const handlers = { onStart: vi.fn(), onProgress: vi.fn() }
      const controller = createSpeechController(handlers)

      await controller.speak({ units: UNITS }, { lookahead: 0 })

      expect(TextToSpeech.speak.mock.calls.map(([options]) => options.text)).toEqual(UNITS)
      expect(handlers.onStart).toHaveBeenCalledWith(3)
      expect(handlers.onProgress.mock.calls.map(([index]) => index)).toEqual([0, 1, 2])
    })

    it('splits only the paragraph that is too long for the engine, and still counts it as one', async () => {
      const handlers = { onProgress: vi.fn() }
      const controller = createSpeechController(handlers)
      const long = `${'Ein wirklich langer deutscher Satz mit Inhalt. '.repeat(6).trim()}`

      await controller.speak({ units: ['Kurzer Absatz hier.', long] }, { maxChars: 100, lookahead: 0 })

      // More engine calls than paragraphs …
      expect(TextToSpeech.speak.mock.calls.length).toBeGreaterThan(2)
      // … but the reader is still told about two paragraphs, and each one only once.
      expect(handlers.onProgress.mock.calls.map(([index, total]) => [index, total])).toEqual([[0, 2], [1, 2]])
    })

    it('starts at the paragraph it is asked to', async () => {
      const controller = createSpeechController()

      await controller.speak({ units: UNITS }, { startAt: 2, lookahead: 0 })

      expect(TextToSpeech.speak.mock.calls.map(([options]) => options.text)).toEqual([UNITS[2]])
    })
  })

  describe('the gap between paragraphs', () => {
    it('hands the next chunk to the engine while the current one is still playing', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak(germanArticle(10), { maxChars: 120, lookahead: 1 })

      // Two utterances are queued before the first has even finished — that is what
      // stops the engine from falling silent while it waits for the next bridge call.
      await waitFor(() => calls.length === 2, 'the look-ahead utterance')
      expect(calls[0].options.queueStrategy).toBe(QueueStrategy.Flush) // clears what was there
      expect(calls[1].options.queueStrategy).toBe(QueueStrategy.Add) // appends, does not flush

      await controller.stop()
      await playback
    })

    it('flushes the engine on the first utterance of every run, and only then', async () => {
      const controller = createSpeechController()

      await controller.speak(germanArticle(6), { maxChars: 120, lookahead: 0 })

      const strategies = TextToSpeech.speak.mock.calls.map(([options]) => options.queueStrategy)
      expect(strategies[0]).toBe(QueueStrategy.Flush)
      strategies.slice(1).forEach(strategy => expect(strategy).toBe(QueueStrategy.Add))
    })
  })

  describe('pause / resume', () => {
    const PARAGRAPH = 'Der erste Teil des Absatzes. Der zweite Teil des Absatzes und noch etwas Text.'

    it('keeps the position and speaks the REST of the paragraph on resume', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()
      const offset = PARAGRAPH.indexOf('Der zweite')

      const playback = controller.speak({ units: [PARAGRAPH, 'Der nächste Absatz ist auch da.'] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the first paragraph')

      // The engine reports it has reached the second sentence.
      emitRange({ start: offset, end: offset + 3, spokenWord: 'Der' })

      await controller.pause()
      expect(controller.isPaused()).toBe(true)
      expect(controller.isSpeaking()).toBe(false)
      expect(TextToSpeech.stop).toHaveBeenCalled()

      controller.resume()
      await waitFor(() => calls.length === 2, 'the rest of the paragraph')

      expect(calls[1].options.text).toBe(PARAGRAPH.slice(offset))
      expect(controller.isSpeaking()).toBe(true)
      expect(controller.isPaused()).toBe(false)

      // … and the queue carries on with the paragraph after it.
      calls[1].resolve()
      await waitFor(() => calls.length === 3, 'the second paragraph')
      expect(calls[2].options.text).toBe('Der nächste Absatz ist auch da.')

      await controller.stop()
      await playback
    })

    it('resumes mid-paragraph under native conditions too (look-ahead queued)', async () => {
      // On the device the controller queues one chunk ahead (QueueStrategy.Add).
      // The resume slice must not be confused by the extra utterance in flight.
      const calls = deferSpeak()
      const controller = createSpeechController()
      const offset = PARAGRAPH.indexOf('Der zweite')

      const playback = controller.speak(
        { units: [PARAGRAPH, 'Der nächste Absatz ist auch da.'] },
        { lookahead: 1 },
      )
      await waitFor(() => calls.length === 2, 'paragraph plus look-ahead')
      expect(calls[0].options.queueStrategy).toBe(QueueStrategy.Flush)
      expect(calls[1].options.queueStrategy).toBe(QueueStrategy.Add)

      emitRange({ start: offset, end: offset + 3, spokenWord: 'Der' })
      await controller.pause()

      controller.resume()
      await waitFor(() => calls.length === 4, 'the resumed slice plus its look-ahead')

      // The rest of the paused paragraph, engine flushed first …
      expect(calls[2].options.text).toBe(PARAGRAPH.slice(offset))
      expect(calls[2].options.queueStrategy).toBe(QueueStrategy.Flush)
      // … and the look-ahead re-queues the FULL next paragraph, not a slice.
      expect(calls[3].options.text).toBe('Der nächste Absatz ist auch da.')

      await controller.stop()
      await playback
    })

    it('a second pause keeps counting from the absolute paragraph position', async () => {
      // After a resume the engine speaks a SLICE, so its onRangeStart offsets are
      // relative to that slice. A second pause must still land on the absolute
      // position — that is what rangeBases is for.
      const calls = deferSpeak()
      const controller = createSpeechController()
      const first = PARAGRAPH.indexOf('zweite')
      const second = PARAGRAPH.slice(first).indexOf('Absatzes')

      const playback = controller.speak({ units: [PARAGRAPH] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the paragraph')

      emitRange({ start: first, end: first + 6 })
      await controller.pause()
      controller.resume()
      await waitFor(() => calls.length === 2, 'the first slice')
      expect(calls[1].options.text).toBe(PARAGRAPH.slice(first))

      emitRange({ start: second, end: second + 8 }) // relative to the slice
      await controller.pause()
      controller.resume()
      await waitFor(() => calls.length === 3, 'the second slice')

      expect(calls[2].options.text).toBe(PARAGRAPH.slice(first + second))

      await controller.stop()
      await playback
    })

    it('still accepts a range event that arrives in the same instant as the pause', async () => {
      // Bridge events are asynchronous: the word the engine reported last can reach
      // JS after pause() has already flipped the state. That late event is the most
      // accurate position there is — it must not be dropped.
      const calls = deferSpeak()
      const controller = createSpeechController()
      const offset = PARAGRAPH.indexOf('Der zweite')

      const playback = controller.speak({ units: [PARAGRAPH] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the paragraph')

      await controller.pause()
      emitRange({ start: offset, end: offset + 3, spokenWord: 'Der' }) // late arrival

      controller.resume()
      await waitFor(() => calls.length === 2, 'the resumed slice')
      expect(calls[1].options.text).toBe(PARAGRAPH.slice(offset))

      await controller.stop()
      await playback
    })

    it('ignores range events once the controller is stopped', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak({ units: [PARAGRAPH, 'Der nächste Absatz ist auch da.'] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the paragraph')
      const listener = emitRange

      await controller.stop()
      listener({ start: 20, end: 23 }) // an event from the flushed utterance

      // A fresh run must start at the top, not at the ghost offset.
      const second = controller.speak({ units: [PARAGRAPH] }, { lookahead: 0 })
      await waitFor(() => calls.length === 2, 'the fresh run')
      expect(calls[1].options.text).toBe(PARAGRAPH)

      await controller.stop()
      await playback
      await second
    })

    it('restarts the paragraph when the engine never reported a word (the web case)', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak({ units: [PARAGRAPH] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the paragraph')

      await controller.pause()
      controller.resume()
      await waitFor(() => calls.length === 2, 'the restarted paragraph')

      expect(calls[1].options.text).toBe(PARAGRAPH)

      await controller.stop()
      await playback
    })

    it('does nothing when nothing is playing', async () => {
      const controller = createSpeechController()

      await controller.pause()
      controller.resume()

      expect(TextToSpeech.speak).not.toHaveBeenCalled()
      expect(controller.isPaused()).toBe(false)
    })

    it('a stop after a pause clears the position for good', async () => {
      const calls = deferSpeak()
      const controller = createSpeechController()

      const playback = controller.speak({ units: [PARAGRAPH] }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the paragraph')

      await controller.pause()
      await controller.stop()

      controller.resume()
      await settle()

      expect(TextToSpeech.speak).toHaveBeenCalledTimes(1) // no resurrection
      expect(controller.isPaused()).toBe(false)
      expect(controller.getProgress()).toEqual({ index: 0, total: 0 })

      await playback
    })
  })

  describe('seeking', () => {
    const UNITS = ['Absatz eins ist hier.', 'Absatz zwei ist hier.', 'Absatz drei ist hier.']

    async function playing() {
      const calls = deferSpeak()
      const handlers = { onEnd: vi.fn(), onProgress: vi.fn() }
      const controller = createSpeechController(handlers)
      const playback = controller.speak({ units: UNITS }, { lookahead: 0 })
      await waitFor(() => calls.length === 1, 'the first paragraph')
      return { calls, controller, handlers, playback }
    }

    it('reads on from the paragraph that was tapped', async () => {
      const { calls, controller, handlers, playback } = await playing()

      controller.seekTo(2)
      await waitFor(() => calls.length === 2, 'the tapped paragraph')

      expect(calls[1].options.text).toBe(UNITS[2])
      expect(controller.getProgress()).toEqual({ index: 2, total: 3 })
      expect(handlers.onProgress).toHaveBeenLastCalledWith(2, 3)

      await controller.stop()
      await playback
    })

    it('steps a paragraph forward and back', async () => {
      const { calls, controller, playback } = await playing()

      controller.next()
      await waitFor(() => calls.length === 2, 'the next paragraph')
      expect(calls[1].options.text).toBe(UNITS[1])

      controller.previous()
      await waitFor(() => calls.length === 3, 'the previous paragraph')
      expect(calls[2].options.text).toBe(UNITS[0])

      // Before the first paragraph there is nothing — stay put rather than misbehave.
      controller.previous()
      await waitFor(() => calls.length === 4, 'the first paragraph again')
      expect(calls[3].options.text).toBe(UNITS[0])

      await controller.stop()
      await playback
    })

    it('past the last paragraph the article is over', async () => {
      const { controller, handlers, playback } = await playing()

      await controller.seekTo(3)

      expect(handlers.onEnd).toHaveBeenCalledTimes(1)
      expect(controller.isSpeaking()).toBe(false)
      expect(controller.isPaused()).toBe(false)

      await playback
    })
  })
})
