import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chunkHtml, translateArticle, translateArticleBlocks } from '../src/utils/ai.js'

const SETTINGS = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: 'sk-test-key',
  model: 'deepseek/deepseek-v4-flash',
}

function reply(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

/** A real SSE stream: each piece arrives as its own delta event. */
function sseReply(pieces, { finishReason = 'stop' } = {}) {
  const encoder = new TextEncoder()
  const events = pieces.map(
    piece => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
  )
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`)
  events.push('data: [DONE]\n\n')
  let index = 0

  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        return {
          read: async () =>
            index < events.length
              ? { done: false, value: encoder.encode(events[index++]) }
              : { done: true, value: undefined },
        }
      },
    },
  }
}

let fetchMock

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chunkHtml', () => {
  it('returns an empty list for empty input', () => {
    expect(chunkHtml('')).toEqual([])
    expect(chunkHtml(null)).toEqual([])
  })

  it('keeps a short article in one chunk', () => {
    expect(chunkHtml('<p>One</p><p>Two</p>')).toEqual(['<p>One</p><p>Two</p>'])
  })

  it('splits along top-level elements, never inside a tag', () => {
    const html = Array.from({ length: 6 }, (_, i) => `<p>${'x'.repeat(2000)}${i}</p>`).join('')

    const chunks = chunkHtml(html, 6000)

    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk must be balanced HTML on its own — this is the whole point of
    // splitting on element boundaries rather than slicing the string.
    for (const chunk of chunks) {
      const opens = (chunk.match(/<p>/g) || []).length
      const closes = (chunk.match(/<\/p>/g) || []).length
      expect(opens).toBe(closes)
    }
    expect(chunks.join('')).toBe(html)
  })

  it('passes an oversized single element through whole rather than cutting it', () => {
    const html = `<p>${'x'.repeat(20000)}</p>`

    const chunks = chunkHtml(html, 6000)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(html)
  })

  it('handles bare text with no elements', () => {
    expect(chunkHtml('just text')).toEqual(['just text'])
  })
})

describe('translateArticle', () => {
  it('refuses without an API key, without making a request', async () => {
    await expect(
      translateArticle({ html: '<p>Hi</p>' }, { ...SETTINGS, apiKey: '' }),
    ).rejects.toThrow('not_configured')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an empty article', async () => {
    await expect(translateArticle({ html: '' }, SETTINGS)).rejects.toThrow('no_content')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('translates the body and the title', async () => {
    fetchMock
      .mockResolvedValueOnce(reply('<p>Hallo</p>'))
      .mockResolvedValueOnce(reply('Eine Überschrift'))

    const result = await translateArticle(
      { html: '<p>Hello</p>', title: 'A headline' },
      SETTINGS,
      { targetLanguage: 'de' },
    )

    expect(result).toEqual({
      html: '<p>Hallo</p>',
      title: 'Eine Überschrift',
      language: 'de',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // A long article must not be truncated — a reader handed an article that simply
  // stops is worse than no translation at all.
  it('sends every chunk of a long article', async () => {
    const html = Array.from({ length: 6 }, (_, i) => `<p>${'x'.repeat(2000)}${i}</p>`).join('')
    const expectedChunks = chunkHtml(html).length
    expect(expectedChunks).toBeGreaterThan(1)

    fetchMock.mockImplementation(async () => reply('<p>translated</p>'))

    const result = await translateArticle({ html, title: '' }, SETTINGS, { targetLanguage: 'de' })

    // One request per chunk; no title request, because there is no title.
    expect(fetchMock).toHaveBeenCalledTimes(expectedChunks)
    expect(result.html).toBe('<p>translated</p>'.repeat(expectedChunks))
  })

  it('reports progress per chunk', async () => {
    const html = Array.from({ length: 6 }, (_, i) => `<p>${'x'.repeat(2000)}${i}</p>`).join('')
    const total = chunkHtml(html).length
    fetchMock.mockImplementation(async () => reply('<p>t</p>'))

    const progress = []
    await translateArticle({ html }, SETTINGS, {
      targetLanguage: 'de',
      onProgress: (done, count) => progress.push([done, count]),
    })

    expect(progress).toEqual(Array.from({ length: total }, (_, i) => [i + 1, total]))
  })

  // Models wrap HTML in code fences however firmly you ask them not to.
  it('strips a markdown code fence from the answer', async () => {
    fetchMock.mockResolvedValueOnce(reply('```html\n<p>Hallo</p>\n```'))

    const result = await translateArticle({ html: '<p>Hello</p>' }, SETTINGS, { targetLanguage: 'de' })

    expect(result.html).toBe('<p>Hallo</p>')
  })

  it('falls back to English for an unknown target language', async () => {
    fetchMock.mockResolvedValue(reply('<p>x</p>'))

    const result = await translateArticle({ html: '<p>x</p>' }, SETTINGS, { targetLanguage: 'klingon' })

    expect(result.language).toBe('en')
  })

  it('propagates a provider error instead of returning half an article', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })

    await expect(
      translateArticle({ html: '<p>Hello</p>' }, SETTINGS, { targetLanguage: 'de' }),
    ).rejects.toThrow('unauthorized')
  })

  it('never leaks the API key in an error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })

    try {
      await translateArticle({ html: '<p>Hello</p>' }, SETTINGS, { targetLanguage: 'de' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(JSON.stringify(Object.getOwnPropertyNames(err).map(k => err[k]))).not.toContain('sk-test-key')
    }
  })
})

describe('translateArticleBlocks (streaming)', () => {
  it('announces each paragraph the moment its closing tag arrives from the stream', async () => {
    fetchMock.mockResolvedValueOnce(sseReply(['<p>Hal', 'lo</p><p>We', 'lt</p>']))

    const previews = []
    const result = await translateArticleBlocks(['<p>Hello</p>', '<p>World</p>'], SETTINGS, {
      targetLanguage: 'de',
      onBlockPreview: (index, html) => previews.push([index, html]),
    })

    expect(previews).toEqual([
      [0, '<p>Hallo</p>'],
      [1, '<p>Welt</p>'],
    ])
    expect(result.chunks.join('')).toBe('<p>Hallo</p><p>Welt</p>')
    expect(result.language).toBe('de')
  })

  it('requests streaming from the provider', async () => {
    fetchMock.mockResolvedValueOnce(sseReply(['<p>x</p>']))

    await translateArticleBlocks(['<p>y</p>'], SETTINGS, { targetLanguage: 'de' })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true)
  })

  it('never previews outside the chunk it belongs to, even if the model invents blocks', async () => {
    fetchMock.mockResolvedValueOnce(sseReply(['<p>a</p><p>extra</p><p>more</p>']))

    const previews = []
    await translateArticleBlocks(['<p>one</p>'], SETTINGS, {
      targetLanguage: 'de',
      onBlockPreview: (index, html) => previews.push([index, html]),
    })

    expect(previews).toEqual([[0, '<p>a</p>']])
  })

  it('resumes at fromChunk without paying for finished chunks again', async () => {
    // Two blocks of ~4k characters → two chunks of one block each.
    const blocks = [`<p>${'a'.repeat(4000)}</p>`, `<p>${'b'.repeat(4000)}</p>`]
    fetchMock.mockResolvedValueOnce(sseReply(['<p>zwei</p>']))

    const doneChunks = []
    const result = await translateArticleBlocks(blocks, SETTINGS, {
      targetLanguage: 'de',
      fromChunk: 1,
      onChunkDone: (index, html) => doneChunks.push([index, html]),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1) // only the missing chunk
    expect(doneChunks).toEqual([[1, '<p>zwei</p>']])
    expect(result.chunks).toEqual(['<p>zwei</p>'])
  })

  it('accepts a server that ignores `stream` and answers with one JSON object', async () => {
    fetchMock.mockResolvedValueOnce(reply('<p>Hallo</p>'))

    const result = await translateArticleBlocks(['<p>Hello</p>'], SETTINGS, { targetLanguage: 'de' })

    expect(result.chunks).toEqual(['<p>Hallo</p>'])
  })

  it('disables model reasoning on OpenRouter — thinking burned the whole answer budget live', async () => {
    fetchMock.mockResolvedValueOnce(sseReply(['<p>x</p>']))

    await translateArticleBlocks(['<p>y</p>'], SETTINGS, { targetLanguage: 'de' })

    // `effort` is OpenRouter's documented central dial — it drives the native knob on
    // every provider, where `enabled: false` only covers the OpenAI-style ones.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({ effort: 'none' })
  })

  it('sends no reasoning field to a custom endpoint — unknown params can 400 there', async () => {
    fetchMock.mockResolvedValueOnce(reply('<p>x</p>'))

    await translateArticleBlocks(['<p>y</p>'], {
      provider: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      model: 'llama3.2',
    }, { targetLanguage: 'de' })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.reasoning).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('redoes a cut-off chunk block by block instead of keeping half an article', async () => {
    // First request: the whole two-block chunk, cut off (finish_reason: length).
    // Then one request per block, each complete.
    fetchMock
      .mockResolvedValueOnce(sseReply(['<p>Hallo</p><p>We'], { finishReason: 'length' }))
      .mockResolvedValueOnce(sseReply(['<p>Hallo</p>']))
      .mockResolvedValueOnce(sseReply(['<p>Welt</p>']))

    const result = await translateArticleBlocks(['<p>Hello</p>', '<p>World</p>'], SETTINGS, {
      targetLanguage: 'de',
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(result.chunks).toEqual(['<p>Hallo</p><p>Welt</p>'])
  })

  it('propagates the truncation when even a single block does not fit', async () => {
    fetchMock.mockResolvedValue(sseReply(['<p>half'], { finishReason: 'length' }))

    await expect(
      translateArticleBlocks(['<p>Hello</p>'], SETTINGS, { targetLanguage: 'de' }),
    ).rejects.toThrow('truncated')
  })
})
