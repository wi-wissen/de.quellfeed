import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUELL_DESCRIPTION_CHARS,
  parseQuellIndices,
  quellFilterArticles,
} from '../src/utils/ai.js'

const API_KEY = 'sk-super-secret-key-1234567890'

const settings = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: API_KEY,
  model: 'deepseek/deepseek-v4-flash',
}

const items = [
  { title: 'Neue Bilder vom James-Webb-Teleskop', description: 'Die NASA zeigt Aufnahmen ferner Galaxien.' },
  { title: 'Kommunalwahl in Hessen', description: 'Die Ergebnisse aus den Landkreisen.' },
  { title: 'Supernova entdeckt', description: 'Astronomen melden eine Explosion in einer Nachbargalaxie.' },
]

function mockJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function mockCompletion(content) {
  return vi.fn(async () => mockJsonResponse({ choices: [{ message: { content } }] }))
}

function lastBody(fetchMock) {
  return JSON.parse(fetchMock.mock.calls.at(-1)[1].body)
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseQuellIndices', () => {
  it('parses a clean JSON array', () => {
    expect(parseQuellIndices('[0,2]', 3)).toEqual([0, 2])
  })

  it('parses an empty array', () => {
    expect(parseQuellIndices('[]', 3)).toEqual([])
  })

  it('takes the first array out of surrounding prose', () => {
    expect(parseQuellIndices('Sure! The matching items are [1, 2] because…', 3)).toEqual([1, 2])
  })

  it('unwraps a code fence', () => {
    expect(parseQuellIndices('```json\n[1]\n```', 3)).toEqual([1])
  })

  it('returns [] for garbage', () => {
    expect(parseQuellIndices('I cannot help with that.', 3)).toEqual([])
  })

  it('returns [] for a non-array JSON answer', () => {
    expect(parseQuellIndices('{"indices": "all of them"}', 3)).toEqual([])
    expect(parseQuellIndices('null', 3)).toEqual([])
    expect(parseQuellIndices('7', 3)).toEqual([])
  })

  it('drops out-of-range and non-integer entries', () => {
    expect(parseQuellIndices('[5, -1, 0, 1.5]', 3)).toEqual([0])
  })

  it('accepts stringified indices, but nothing else stringy', () => {
    expect(parseQuellIndices('["1", "banana"]', 3)).toEqual([1])
  })

  it('deduplicates and sorts', () => {
    expect(parseQuellIndices('[2, 0, 2, 0]', 3)).toEqual([0, 2])
  })

  it('returns [] for empty text or a zero batch', () => {
    expect(parseQuellIndices('', 3)).toEqual([])
    expect(parseQuellIndices('[0]', 0)).toEqual([])
  })
})

describe('quellFilterArticles', () => {
  it('sends the wish and a numbered title+snippet list, and returns the indices', async () => {
    const fetchMock = mockCompletion('[0,2]')
    vi.stubGlobal('fetch', fetchMock)

    const result = await quellFilterArticles('keine Themen zur Astronomie', items, settings)

    expect(result).toEqual([0, 2])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = lastBody(fetchMock)
    const user = body.messages.at(-1).content
    expect(user).toContain('keine Themen zur Astronomie')
    expect(user).toContain('0. Neue Bilder vom James-Webb-Teleskop')
    expect(user).toContain('1. Kommunalwahl in Hessen')
    expect(user).toContain('2. Supernova entdeckt')
    expect(user).toContain('Die NASA zeigt Aufnahmen ferner Galaxien.')

    // Deterministic classification and a JSON-array-only contract.
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toContain('JSON array')
  })

  it('truncates long descriptions to the snippet budget', async () => {
    const fetchMock = mockCompletion('[]')
    vi.stubGlobal('fetch', fetchMock)

    const long = 'w'.repeat(QUELL_DESCRIPTION_CHARS * 5)
    await quellFilterArticles('no sports', [{ title: 'T', description: long }], settings)

    const user = lastBody(fetchMock).messages.at(-1).content
    // Title line plus truncated snippet — nowhere near the full description.
    expect(user.length).toBeLessThan(QUELL_DESCRIPTION_CHARS * 3)
    expect(user).toContain('…')
  })

  it('answers [] for an unparseable model reply instead of failing', async () => {
    vi.stubGlobal('fetch', mockCompletion('Everything should be suppressed!!'))

    expect(await quellFilterArticles('no sports', items, settings)).toEqual([])
  })

  it('does not call the provider without a prompt or without items', async () => {
    const fetchMock = mockCompletion('[]')
    vi.stubGlobal('fetch', fetchMock)

    expect(await quellFilterArticles('   ', items, settings)).toEqual([])
    expect(await quellFilterArticles('no sports', [], settings)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws not_configured without a key and never touches fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(quellFilterArticles('no sports', items, { ...settings, apiKey: '' }))
      .rejects.toThrow('not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws server_error on a 500 (the store fails open on it)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({ error: { message: 'boom' } }, 500)))

    await expect(quellFilterArticles('no sports', items, settings)).rejects.toThrow('server_error')
  })

  it('aborts a hanging provider after the timeout', async () => {
    // A fetch that only ever resolves through its abort signal — the timeout is
    // the single thing standing between this and a refresh that hangs forever.
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.')
        err.name = 'AbortError'
        reject(err)
      })
    })))

    await expect(quellFilterArticles('no sports', items, settings, { timeoutMs: 20 }))
      .rejects.toThrow('aborted')
  })

  it('never leaks the api key into logs or errors', async () => {
    const infoSpy = console.info
    const errorSpy = console.error

    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse(
      { error: { message: `Invalid key: ${API_KEY}` } },
      401,
    )))

    let caught
    try {
      await quellFilterArticles('no sports', items, settings)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeTruthy()
    expect(caught.message).toBe('unauthorized')
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(API_KEY)

    const logged = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat()
    expect(JSON.stringify(logged)).not.toContain(API_KEY)
  })
})
