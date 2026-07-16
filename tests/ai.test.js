import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_PROVIDERS,
  MAX_ARTICLE_CHARS,
  chatCompletion,
  detectArticleLanguage,
  isAiConfigured,
  resolveAiConfig,
  summarizeArticle,
  truncateForPrompt,
} from '../src/utils/ai.js'

const API_KEY = 'sk-super-secret-key-1234567890'

const openRouterSettings = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: API_KEY,
  model: 'deepseek/deepseek-v4-flash',
}

function mockJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function mockCompletion(content = 'Eine kurze Zusammenfassung.') {
  return vi.fn(async () => mockJsonResponse({ choices: [{ message: { content } }] }))
}

function lastRequest(fetchMock) {
  return fetchMock.mock.calls.at(-1)
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI_PROVIDERS', () => {
  it('offers openrouter, openai and custom', () => {
    expect(AI_PROVIDERS.map(p => p.id)).toEqual(['openrouter', 'openai', 'custom'])
  })

  it('does not offer openrouter/auto', () => {
    const openrouter = AI_PROVIDERS.find(p => p.id === 'openrouter')
    expect(openrouter.models.map(m => m.id)).not.toContain('openrouter/auto')
  })

  it('flags the free models router with a note key for the UI', () => {
    const openrouter = AI_PROVIDERS.find(p => p.id === 'openrouter')
    const free = openrouter.models.find(m => m.id === 'openrouter/free')

    expect(free).toBeTruthy()
    expect(free.note).toBe('freeRouter')
  })
})

describe('resolveAiConfig', () => {
  it('resolves the openrouter preset', () => {
    const config = resolveAiConfig(openRouterSettings)

    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(config.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('resolves the openai preset', () => {
    const config = resolveAiConfig({ provider: 'openai', apiKey: API_KEY })

    expect(config.baseUrl).toBe('https://api.openai.com/v1')
    expect(config.model).toBe(AI_PROVIDERS.find(p => p.id === 'openai').models[0].id)
  })

  it('lets the preset baseUrl win over a stored one', () => {
    const config = resolveAiConfig({ ...openRouterSettings, baseUrl: 'https://evil.example.com/v1' })

    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1')
  })

  it('uses the user baseUrl and model for custom', () => {
    const config = resolveAiConfig({
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1/',
      apiKey: 'ollama',
      model: 'llama3.2',
    })

    expect(config.baseUrl).toBe('http://localhost:11434/v1')
    expect(config.model).toBe('llama3.2')
  })

  it('normalizes trailing slashes and a pasted /chat/completions path', () => {
    expect(resolveAiConfig({ provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1///' }).baseUrl)
      .toBe('https://api.groq.com/openai/v1')
    expect(resolveAiConfig({ provider: 'custom', baseUrl: 'https://api.groq.com/openai/v1/chat/completions' }).baseUrl)
      .toBe('https://api.groq.com/openai/v1')
  })

  it('defaults to the openrouter preset when nothing is stored', () => {
    const config = resolveAiConfig({})

    expect(config.provider).toBe('openrouter')
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(config.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('keeps a custom model on a preset provider', () => {
    const config = resolveAiConfig({ ...openRouterSettings, model: 'openrouter/free' })

    expect(config.model).toBe('openrouter/free')
  })

  it('also accepts the whole store settings object with an ai key', () => {
    const config = resolveAiConfig({ theme: 'dark', language: 'de', ai: openRouterSettings })

    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(config.apiKey).toBe(API_KEY)
  })

  it('redacts the api key when the config is stringified', () => {
    const json = JSON.stringify(resolveAiConfig(openRouterSettings))

    expect(json).not.toContain(API_KEY)
    expect(json).toContain('[redacted]')
  })
})

describe('isAiConfigured', () => {
  it('is false without a key', () => {
    expect(isAiConfigured({ ...openRouterSettings, apiKey: '' })).toBe(false)
  })

  it('is false for custom without a baseUrl', () => {
    expect(isAiConfigured({ provider: 'custom', apiKey: API_KEY, model: 'llama3.2' })).toBe(false)
  })

  it('is false for custom without a model', () => {
    expect(isAiConfigured({ provider: 'custom', apiKey: API_KEY, baseUrl: 'http://localhost:11434/v1' })).toBe(false)
  })

  it('is true for a complete preset config', () => {
    expect(isAiConfigured(openRouterSettings)).toBe(true)
  })
})

describe('detectArticleLanguage', () => {
  it('detects german', () => {
    expect(detectArticleLanguage('Der Bericht ist nicht neu und wurde auch schon über die Medien verbreitet.')).toBe('de')
  })

  it('detects english', () => {
    expect(detectArticleLanguage('The report is not new and was also shared with the press about a week ago.')).toBe('en')
  })

  it('falls back for empty text', () => {
    expect(detectArticleLanguage('', 'de')).toBe('de')
  })
})

describe('truncateForPrompt', () => {
  it('leaves short text alone', () => {
    expect(truncateForPrompt('Kurz und knapp.')).toBe('Kurz und knapp.')
  })

  it('truncates long text to the limit', () => {
    const long = 'wort '.repeat(MAX_ARTICLE_CHARS)
    const result = truncateForPrompt(long)

    expect(result.length).toBeLessThanOrEqual(MAX_ARTICLE_CHARS + 1)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('summarizeArticle', () => {
  it('posts to the right url with a bearer header and returns the summary', async () => {
    const fetchMock = mockCompletion('Das ist die Zusammenfassung.')
    vi.stubGlobal('fetch', fetchMock)

    const summary = await summarizeArticle(
      { title: 'Titel', text: 'Der Artikel ist nicht besonders lang und wurde schon über die Medien verbreitet.' },
      openRouterSettings,
    )

    expect(summary).toBe('Das ist die Zusammenfassung.')

    const [url, init] = lastRequest(fetchMock)
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(init.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(init.body)
    expect(body.model).toBe('deepseek/deepseek-v4-flash')
    expect(body.messages.at(-1).content).toContain('Titel')
    expect(body.stream).toBe(false)
  })

  it('sends the openrouter attribution headers only to openrouter', async () => {
    const fetchMock = mockCompletion()
    vi.stubGlobal('fetch', fetchMock)

    await summarizeArticle({ title: 'T', text: 'The article is not long.' }, openRouterSettings)
    expect(lastRequest(fetchMock)[1].headers['X-Title']).toBe('Quell Feed')
    expect(lastRequest(fetchMock)[1].headers['HTTP-Referer']).toBeTruthy()

    await summarizeArticle({ title: 'T', text: 'The article is not long.' }, {
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'llama3.2',
    })
    expect(lastRequest(fetchMock)[0]).toBe('http://localhost:11434/v1/chat/completions')
    expect(lastRequest(fetchMock)[1].headers['X-Title']).toBeUndefined()
    expect(lastRequest(fetchMock)[1].headers['HTTP-Referer']).toBeUndefined()
  })

  it('asks for the summary in the APP language, whatever the article speaks', async () => {
    const fetchMock = mockCompletion()
    vi.stubGlobal('fetch', fetchMock)

    // English article, German UI → the reader gets a German TL;DR.
    await summarizeArticle(
      { title: 'Title', text: 'The report is not new and was also shared with the press about a week ago.' },
      openRouterSettings,
      { language: 'de' },
    )
    expect(JSON.parse(lastRequest(fetchMock)[1].body).messages[0].content).toContain('German')

    // No language given → English, never a guess from the article.
    await summarizeArticle(
      { title: 'Titel', text: 'Der Bericht ist nicht neu und wurde auch schon über die Medien verbreitet.' },
      openRouterSettings,
    )
    expect(JSON.parse(lastRequest(fetchMock)[1].body).messages[0].content).not.toContain('German')
  })

  it('truncates a very long article before sending it', async () => {
    const fetchMock = mockCompletion()
    vi.stubGlobal('fetch', fetchMock)

    const text = 'A'.repeat(MAX_ARTICLE_CHARS * 3)
    await summarizeArticle({ title: 'Long', text }, openRouterSettings)

    const body = JSON.parse(lastRequest(fetchMock)[1].body)
    const userMessage = body.messages.at(-1).content

    expect(userMessage.length).toBeLessThan(MAX_ARTICLE_CHARS + 200)
    expect(userMessage).toContain('…')
  })

  it('reads content that comes back as parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({
      choices: [{ message: { content: [{ type: 'text', text: 'Teil eins.' }] } }],
    })))

    const summary = await summarizeArticle({ title: 'T', text: 'The article is not long.' }, openRouterSettings)
    expect(summary).toBe('Teil eins.')
  })

  it('throws no_content for an empty article', async () => {
    const fetchMock = mockCompletion()
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarizeArticle({ title: 'T', text: '   ' }, openRouterSettings)).rejects.toThrow('no_content')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws empty_response when the provider returns no content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({ choices: [] })))

    await expect(summarizeArticle({ title: 'T', text: 'The article is not long.' }, openRouterSettings))
      .rejects.toThrow('empty_response')
  })
})

describe('error handling', () => {
  const article = { title: 'T', text: 'The article is not long.' }

  it('throws not_configured without a key and never touches fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarizeArticle(article, { ...openRouterSettings, apiKey: '' }))
      .rejects.toThrow('not_configured')
    await expect(chatCompletion([{ role: 'user', content: 'hi' }], { ...openRouterSettings, apiKey: '' }))
      .rejects.toThrow('not_configured')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [402, 'insufficient_credits'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'request_failed'],
  ])('maps status %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({ error: { message: 'nope' } }, status)))

    await expect(summarizeArticle(article, openRouterSettings)).rejects.toThrow(code)
  })

  it('maps an error object in a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse({ error: { code: 429, message: 'slow down' } })))

    await expect(summarizeArticle(article, openRouterSettings)).rejects.toThrow('rate_limited')
  })

  it('maps a failed fetch to network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    await expect(summarizeArticle(article, openRouterSettings)).rejects.toThrow('network_error')
  })

  it('maps an aborted request to aborted', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      const err = new Error('The operation was aborted.')
      err.name = 'AbortError'
      throw err
    }))

    await expect(summarizeArticle(article, openRouterSettings, { signal: controller.signal }))
      .rejects.toThrow('aborted')
  })

  it('passes the abort signal on to fetch', async () => {
    const fetchMock = mockCompletion()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await summarizeArticle(article, openRouterSettings, { signal: controller.signal })

    expect(lastRequest(fetchMock)[1].signal).toBe(controller.signal)
  })

  it('never leaks the api key into an error message or a log line', async () => {
    const infoSpy = console.info
    const errorSpy = console.error

    vi.stubGlobal('fetch', vi.fn(async () => mockJsonResponse(
      // A provider that echoes the request back — the worst case.
      { error: { message: `Invalid key: ${API_KEY}`, request: { headers: { Authorization: `Bearer ${API_KEY}` } } } },
      401,
    )))

    let caught
    try {
      await summarizeArticle(article, openRouterSettings)
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

describe('chatCompletion', () => {
  it('honours maxTokens', async () => {
    const fetchMock = mockCompletion('ok')
    vi.stubGlobal('fetch', fetchMock)

    const result = await chatCompletion(
      [{ role: 'user', content: 'Hallo' }],
      openRouterSettings,
      { maxTokens: 42 },
    )

    expect(result).toBe('ok')
    expect(JSON.parse(lastRequest(fetchMock)[1].body).max_tokens).toBe(42)
  })
})
