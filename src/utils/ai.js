// BYOK (Bring Your Own Key) AI helpers.
//
// Quell has no backend and never will, so every AI call goes straight from the
// device to the provider the user picked. We speak the OpenAI-compatible
// /chat/completions dialect, which every relevant provider (OpenRouter, OpenAI,
// Ollama, LM Studio, Groq, …) understands.
//
// We deliberately do NOT go through src/utils/http.js: that helper is GET-only
// and routes through the Vite dev proxy.
//
// ── CORS (checked against both APIs, 2026-07) ───────────────────────────────
// Native (Capacitor WebView): no CORS at all, every provider works.
// Browser (dev / web build):
//   • OpenRouter: `Access-Control-Allow-Origin: *`, `Authorization` explicitly
//     allowed. Direct browser calls are supported by design.
//   • OpenAI: api.openai.com nowadays mirrors any Origin back and answers the
//     preflight with 200 — the old "no Access-Control-Allow-Origin" problem is
//     gone. (The JS SDK's `dangerouslyAllowBrowser` flag is a key-leak guard for
//     apps that ship *their own* key, not a CORS limit. BYOK sidesteps that.)
//   • Custom endpoints depend on the server (local Ollama/LM Studio need CORS
//     enabled, e.g. OLLAMA_ORIGINS).

import { splitHtmlBlocks, planTranslationChunks, createHtmlBlockScanner } from './htmlBlocks.js'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

// The app identity OpenRouter shows on its public rankings. Both headers are
// optional per the OpenRouter docs (App Attribution), so we only send them to
// OpenRouter — adding unknown headers to a custom endpoint would just cause
// extra CORS preflight trouble.
const APP_TITLE = 'Quell Feed'
const APP_URL = 'https://github.com/quell-feed'

// Long-form articles blow up cost and latency for no benefit — a TL;DR needs the
// beginning of a text, not all of it. ~12k characters ≈ 3–4k tokens.
export const MAX_ARTICLE_CHARS = 12000

const DEFAULT_MAX_TOKENS = 400
const DEFAULT_SUMMARY_MAX_TOKENS = 320
const DEFAULT_TEMPERATURE = 0.3

export const AI_PROVIDERS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: OPENROUTER_BASE_URL,
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      // OpenRouter's "Free Models Router". Needs nothing but an own API key, but
      // whether the output of free models may be reused is legally unclear — the
      // UI shows `note` as a warning (i18n key: settings.ai.notes.freeRouter).
      { id: 'openrouter/free', label: 'Free Models Router', note: 'freeRouter' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: OPENAI_BASE_URL,
    models: [
      // Cheapest current chat model ($0.20 / $1.25 per 1M tokens), served on
      // /chat/completions like everything else here.
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano' },
    ],
  },
  {
    // baseUrl and model are supplied by the user — any OpenAI-compatible endpoint.
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    models: [],
  },
]

/**
 * The flat list the settings screen offers as a single choice. A preset is nothing
 * but a (provider, model) pair — deliberately NOT a stored field, so that editing
 * the model afterwards cannot leave the saved preset lying about what is configured.
 * `matchPreset()` derives the selection back from the settings.
 */
export const AI_PRESETS = [
  {
    id: 'openrouter-deepseek',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
  },
  {
    id: 'openrouter-free',
    provider: 'openrouter',
    model: 'openrouter/free',
    note: 'freeRouter',
  },
  {
    id: 'openai-nano',
    provider: 'openai',
    model: 'gpt-5.4-nano',
  },
  {
    id: 'custom',
    provider: 'custom',
    model: '',
  },
]

export const DEFAULT_AI_SETTINGS = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: '',
  model: 'deepseek/deepseek-v4-flash',
}

export function getAiProvider(providerId) {
  return AI_PROVIDERS.find(p => p.id === providerId) || null
}

export function getAiPreset(presetId) {
  return AI_PRESETS.find(p => p.id === presetId) || null
}

/**
 * Which preset the current settings correspond to. `custom` matches on provider
 * alone (its model is free text); the others need provider AND model to agree, so
 * that a hand-edited model shows up as "own model" rather than silently claiming
 * to be a preset.
 */
export function matchPreset(settings) {
  const s = settings?.ai ? settings.ai : (settings || {})
  if (s.provider === 'custom') return 'custom'

  const hit = AI_PRESETS.find(p => p.provider === s.provider && p.model === s.model)
  return hit ? hit.id : null
}

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '')
    .trim()
    // Users happily paste the full endpoint they found in some doc.
    .replace(/\/+chat\/completions\/*$/i, '')
    .replace(/\/+$/, '')
}

// Accepts either the AI settings object itself or the whole store settings with
// an `ai` key on it, so callers can stay sloppy without leaking bugs.
function pickAiSettings(settings) {
  if (!settings || typeof settings !== 'object') return {}
  if (settings.ai && typeof settings.ai === 'object') return settings.ai
  return settings
}

/**
 * Normalizes stored settings into the effective config.
 * For a preset provider its baseUrl always wins; for `custom` the user's does.
 *
 * @param {{provider?: string, baseUrl?: string, apiKey?: string, model?: string}} settings
 * @returns {{provider: string, baseUrl: string, apiKey: string, model: string}}
 */
export function resolveAiConfig(settings) {
  const s = pickAiSettings(settings)
  const provider = String(s.provider || DEFAULT_AI_SETTINGS.provider).trim()
  const preset = getAiProvider(provider)
  const userModel = String(s.model || '').trim()

  const isPreset = Boolean(preset && preset.baseUrl)
  const baseUrl = isPreset ? normalizeBaseUrl(preset.baseUrl) : normalizeBaseUrl(s.baseUrl)
  const model = userModel || (isPreset ? preset.models[0]?.id || '' : '')

  const config = {
    provider,
    baseUrl,
    apiKey: String(s.apiKey || '').trim(),
    model,
  }

  // Belt and braces: nothing that stringifies this config (a log line, an error
  // report, a bug ticket) may ever carry the key out of the device.
  Object.defineProperty(config, 'toJSON', {
    enumerable: false,
    value() {
      return { provider, baseUrl, model, apiKey: config.apiKey ? '[redacted]' : '' }
    },
  })

  return config
}

/**
 * True when the config can actually be used for a request.
 * A key is required — endpoints that do not need one (Ollama, LM Studio) accept
 * any dummy string, so demanding one costs nothing and catches the real mistake.
 */
export function isAiConfigured(settings) {
  const { apiKey, baseUrl, model } = resolveAiConfig(settings)
  return Boolean(apiKey && baseUrl && model)
}

// ── Language ────────────────────────────────────────────────────────────────
// A cheap stopword heuristic for de/en — the only languages the app itself
// speaks. Used by the read-aloud feature to pick the right TTS voice for the
// article. (The SUMMARY deliberately does not use it: a summary is written for
// the reader and therefore in the app language, whatever the article speaks.)
const DE_STOPWORDS = /\b(der|die|das|und|ist|nicht|mit|ein|eine|für|auch|sich|werden|wurde|aber|noch|schon|beim|durch|über)\b/gi
const EN_STOPWORDS = /\b(the|and|is|not|with|a|an|for|also|of|to|that|this|was|were|but|from|have|about)\b/gi

export function detectArticleLanguage(text = '', fallback = 'en') {
  const sample = String(text || '').slice(0, 2000)
  if (!sample.trim()) return fallback

  const de = (sample.match(DE_STOPWORDS) || []).length
  const en = (sample.match(EN_STOPWORDS) || []).length
  if (de === en) return fallback
  return de > en ? 'de' : 'en'
}

export function truncateForPrompt(text = '', limit = MAX_ARTICLE_CHARS) {
  const value = String(text || '').trim()
  if (value.length <= limit) return value

  const cut = value.slice(0, limit)
  // Cut on a word boundary if there is one nearby, so we don't hand the model a
  // half-word as the last thing it sees.
  const lastSpace = cut.lastIndexOf(' ')
  const body = lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut
  return `${body.trimEnd()}…`
}

// ── Requests ────────────────────────────────────────────────────────────────

function buildHeaders(config) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  }

  // Optional per OpenRouter's docs, but they are what makes the app show up in
  // their rankings (HTTP-Referer is the identifier, X-Title the display name)
  // — and only OpenRouter knows what to do with them.
  if (config.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = APP_URL
    headers['X-Title'] = APP_TITLE
  }

  return headers
}

/**
 * One request body for both the buffered and the streaming path.
 *
 * The reasoning knobs are the important part: reasoning models burn the completion
 * budget on hidden thinking — measured live, DeepSeek V4 Flash spent 3073 of 4001
 * tokens "thinking about" a translation and the answer broke off mid-tag (and a
 * 120-token headline request came back with no content at all). Everything this app
 * asks for is mechanical — translate, summarize, classify — so thinking is pure cost.
 * The knob is vendor-specific, hence the per-host switch; a custom endpoint gets a
 * clean OpenAI-compatible body without surprises.
 *
 * OpenRouter's documented central dial is `reasoning.effort` ("one effort value drives
 * the native reasoning control on Anthropic, OpenAI, and Google") — `effort: 'none'`
 * turns thinking off across every catalog model that supports the knob, where a bare
 * `enabled: false` is only the OpenAI-style subset of it.
 */
function buildRequestBody(config, model, messages, options, stream) {
  const body = {
    model,
    messages,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    stream,
  }

  if (config.baseUrl.includes('openrouter.ai')) {
    body.reasoning = { effort: 'none' }
  } else if (config.baseUrl.includes('api.openai.com')) {
    body.reasoning_effort = 'minimal'
  }

  return body
}

function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 402) return 'insufficient_credits'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'request_failed'
}

// Never let a provider's error text through unfiltered — some echo the request
// back, and we will not risk the key ending up in a message the UI may render.
function throwProviderError(status) {
  const error = new Error(errorCodeForStatus(status))
  error.status = status
  throw error
}

function extractContent(data) {
  const message = data?.choices?.[0]?.message
  const content = message?.content

  if (typeof content === 'string') return content.trim()

  // Some providers return content as parts ([{ type: 'text', text: '…' }]).
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim()
  }

  return ''
}

/**
 * Low-level chat completion. POSTs to `${baseUrl}/chat/completions`.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} settings stored AI settings
 * @param {{signal?: AbortSignal, maxTokens?: number, temperature?: number, model?: string}} [options]
 * @returns {Promise<string>} the assistant message content
 * @throws {Error} message is one of: not_configured, unauthorized, insufficient_credits,
 *   rate_limited, server_error, request_failed, network_error, aborted, empty_response
 */
export async function chatCompletion(messages, settings, options = {}) {
  const config = resolveAiConfig(settings)
  if (!isAiConfigured(config)) throw new Error('not_configured')

  const model = options.model || config.model
  const url = `${config.baseUrl}/chat/completions`

  // Logs carry the model and the endpoint, never the key or the article.
  console.info('[ai] chatCompletion', { provider: config.provider, url, model })

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(buildRequestBody(config, model, messages, options, false)),
      signal: options.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError' || options.signal?.aborted) throw new Error('aborted')
    console.error('[ai] request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  if (!res.ok) {
    console.error('[ai] provider responded with', res.status)
    throwProviderError(res.status)
  }

  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('empty_response')
  }

  // OpenAI-compatible providers may answer 200 with an error object in the body.
  if (data?.error) {
    const status = Number(data.error.code) || Number(data.error.status) || 0
    console.error('[ai] provider returned an error object', { status })
    throwProviderError(status)
  }

  const content = extractContent(data)
  if (!content) throw new Error('empty_response')

  return content
}

// Provider error codes chatCompletion(Stream) can throw — used to tell "already
// classified" apart from raw transport errors when a stream dies halfway.
const PROVIDER_ERROR_CODES = new Set([
  'unauthorized', 'insufficient_credits', 'rate_limited', 'server_error',
  'request_failed', 'empty_response', 'aborted', 'network_error', 'not_configured',
  'truncated',
])

/**
 * The WebView's own fetch. With the CapacitorHttp plugin enabled, `window.fetch` is
 * PATCHED: every request runs through the native HTTP layer, which buffers the whole
 * response — an SSE stream then arrives in one lump at the very end, i.e. never
 * streams. Capacitor keeps the original under `window.CapacitorWebFetch`; that one
 * streams, but is subject to CORS again (which OpenRouter and OpenAI both allow).
 */
function streamCapableFetch() {
  if (typeof window !== 'undefined' && typeof window.CapacitorWebFetch === 'function') {
    return { fetchFn: window.CapacitorWebFetch.bind(window), viaWebFetch: true }
  }
  return { fetchFn: fetch, viaWebFetch: false }
}

/**
 * Streaming chat completion (`stream: true`, SSE). `options.onText` receives the
 * FULL text so far after every delta — accumulation lives here, so no caller can
 * get it subtly wrong.
 *
 * Servers that ignore `stream` and answer with one JSON object are accepted: their
 * whole answer arrives as a single onText call. Same error codes as chatCompletion.
 *
 * A custom endpoint without CORS headers fails the streaming (web) fetch on native —
 * that case falls back to one buffered chatCompletion through the native layer, so
 * translation still works there, only without the live paragraphs.
 *
 * @returns {Promise<string>} the complete assistant message
 */
export async function chatCompletionStream(messages, settings, options = {}) {
  const { fetchFn, viaWebFetch } = streamCapableFetch()

  try {
    return await requestCompletionStream(fetchFn, messages, settings, options)
  } catch (err) {
    // Only the CORS-bound web fetch earns a retry, and only for transport failures —
    // provider verdicts (401, 402, …) are the same on every path.
    if (viaWebFetch && err instanceof Error && err.message === 'network_error') {
      console.warn('[ai] streaming fetch failed (endpoint without CORS?) — buffered retry')
      const content = await chatCompletion(messages, settings, options)
      options.onText?.(content)
      return content
    }
    throw err
  }
}

async function requestCompletionStream(fetchFn, messages, settings, options = {}) {
  const config = resolveAiConfig(settings)
  if (!isAiConfigured(config)) throw new Error('not_configured')

  const model = options.model || config.model
  const url = `${config.baseUrl}/chat/completions`

  // Logs carry the model and the endpoint, never the key or the article.
  console.info('[ai] chatCompletionStream', { provider: config.provider, url, model })

  let res
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(buildRequestBody(config, model, messages, options, true)),
      signal: options.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError' || options.signal?.aborted) throw new Error('aborted')
    console.error('[ai] request failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  if (!res.ok) {
    console.error('[ai] provider responded with', res.status)
    throwProviderError(res.status)
  }

  let finishReason = null

  // A JSON body (or an environment without response streaming) → one big delta.
  const contentType = res.headers?.get?.('content-type') || ''
  if (!res.body?.getReader || contentType.includes('application/json')) {
    let data
    try {
      data = await res.json()
    } catch {
      throw new Error('empty_response')
    }
    if (data?.error) {
      const status = Number(data.error.code) || Number(data.error.status) || 0
      console.error('[ai] provider returned an error object', { status })
      throwProviderError(status)
    }
    const content = extractContent(data)
    if (!content) throw new Error('empty_response')
    assertNotTruncated(data?.choices?.[0]?.finish_reason, options)
    options.onText?.(content)
    return content
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json?.error) {
          const status = Number(json.error.code) || Number(json.error.status) || 0
          console.error('[ai] provider streamed an error object', { status })
          throwProviderError(status)
        }

        finishReason = json?.choices?.[0]?.finish_reason || finishReason

        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content
        const piece = typeof delta === 'string'
          ? delta
          : Array.isArray(delta)
            ? delta.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
            : ''
        if (piece) {
          content += piece
          options.onText?.(content)
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && PROVIDER_ERROR_CODES.has(err.message)) throw err
    if (err?.name === 'AbortError' || options.signal?.aborted) throw new Error('aborted')
    console.error('[ai] stream failed:', err?.name || 'Error')
    throw new Error('network_error')
  }

  assertNotTruncated(finishReason, options)

  const trimmed = content.trim()
  if (!trimmed) throw new Error('empty_response')
  return trimmed
}

/**
 * `finish_reason: length` means the model ran out of completion budget MID-ANSWER.
 * For a translation that is half an article silently gone — callers that cannot
 * accept that opt in via `failOnTruncation` and get a retryable error instead.
 */
function assertNotTruncated(finishReason, options) {
  if (finishReason !== 'length') return
  console.warn('[ai] completion was cut off (finish_reason: length)')
  if (options.failOnTruncation) throw new Error('truncated')
}

function buildSummaryMessages(title, text, language) {
  const languageName = language === 'de' ? 'German (Deutsch)' : 'English'

  const system = [
    'You are a concise news summarizer inside an RSS reader.',
    'Write a TL;DR of the article: 2–4 short sentences, plain prose, no headline, no markdown, no bullet points, no preamble like "This article".',
    'Only use information from the article itself. Never invent facts.',
    // The reader's language, NOT the article's: the TL;DR decides whether the
    // article is worth the reader's time, so it must be in the reader's language.
    `Write the summary in ${languageName} — the language of the reader's app. Keep it in ${languageName} even when the article itself is written in another language.`,
  ].join(' ')

  const user = [title ? `Title: ${title}` : null, '', text].filter(v => v !== null).join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * Summarizes an article (TL;DR).
 *
 * @param {{title?: string, text?: string}} article the article text is truncated to MAX_ARTICLE_CHARS
 * @param {object} settings stored AI settings
 * @param {{signal?: AbortSignal, maxTokens?: number, language?: string}} [options]
 *   `language` is the app language — the summary is written in it regardless of
 *   the article's own language.
 * @returns {Promise<string>} the summary
 * @throws {Error} `no_content` plus every code chatCompletion can throw
 */
export async function summarizeArticle(article, settings, options = {}) {
  if (!isAiConfigured(settings)) throw new Error('not_configured')

  const title = String(article?.title || '').trim()
  const text = truncateForPrompt(article?.text)
  if (!text) throw new Error('no_content')

  const language = options.language === 'de' ? 'de' : 'en'

  return chatCompletion(buildSummaryMessages(title, text, language), settings, {
    signal: options.signal,
    maxTokens: options.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
  })
}

// ── Translation ─────────────────────────────────────────────────────────────

// A summary may be built from the first 12k characters — the end of a long article
// adds little to a TL;DR. A *translation* may not: truncating it hands the reader an
// article that simply stops. So the HTML is chunked and every chunk is translated.
export const TRANSLATION_CHUNK_CHARS = 6000

// Output is roughly as long as input, and German runs longer than English. Generous
// on purpose: ~6k characters of HTML are 2–3k output tokens, and a ceiling that is
// ever reached means half a chunk silently gone (see failOnTruncation).
const TRANSLATION_MAX_TOKENS = 8000

// A headline is a sentence; 120 proved too tight in practice the moment a model
// spent tokens on anything but the answer.
const TITLE_MAX_TOKENS = 500

export const LANGUAGE_NAMES = { de: 'German', en: 'English' }

/**
 * Splits article HTML into chunks along TOP-LEVEL element boundaries, so no chunk
 * ever ends inside an open tag. Oversized single elements are passed through whole
 * rather than cut — a broken tag is worse than a long request.
 */
export function chunkHtml(html, limit = TRANSLATION_CHUNK_CHARS) {
  return planTranslationChunks(splitHtmlBlocks(html), limit).map(chunk => chunk.html)
}

function buildTranslationMessages(chunk, targetName) {
  const system = [
    'You translate HTML fragments of a news article inside an RSS reader.',
    `Translate all human-readable text into ${targetName}.`,
    'Return ONLY the translated HTML fragment. No markdown, no code fences, no commentary.',
    'Preserve the HTML structure EXACTLY: same tags, same nesting, same order, same attributes.',
    'Never translate, rewrite or drop attribute values — src, href and class must stay byte-identical.',
    'Translate alt titles and visible text only. Do not add, remove or merge elements.',
    'If a fragment is already in the target language, return it unchanged.',
  ].join(' ')

  return [
    { role: 'system', content: system },
    { role: 'user', content: chunk },
  ]
}

/**
 * Translates one short plain-text string (the article headline).
 * @returns {Promise<string>} '' for empty input
 */
export async function translateText(text, settings, options = {}) {
  const value = String(text || '').trim()
  if (!value) return ''

  const target = LANGUAGE_NAMES[options.targetLanguage] ? options.targetLanguage : 'en'

  return stripCodeFence(await chatCompletion(
    [
      { role: 'system', content: `Translate this article headline into ${LANGUAGE_NAMES[target]}. Return only the headline, nothing else.` },
      { role: 'user', content: value },
    ],
    settings,
    { signal: options.signal, maxTokens: TITLE_MAX_TOKENS },
  ))
}

/**
 * Translates an article's top-level blocks (see splitHtmlBlocks), chunk by chunk,
 * STREAMING: while a chunk is still arriving, every block whose closing tag has
 * completed is announced through `onBlockPreview(blockIndex, html)` so the reading
 * view can swap paragraphs in as they finish. `onChunkDone(chunkIndex, html)` then
 * carries the authoritative text for that chunk.
 *
 * Resumable: `fromChunk` skips chunks a previous, interrupted run already finished —
 * the plan is deterministic for the same blocks, so indices line up. Chunks run
 * sequentially on purpose: a chunk that fails must not leave the reader with a
 * half-translated article, and rate limits are easier to survive one at a time.
 *
 * Every emitted string is model output and therefore untrusted: the CALLER MUST run
 * it through DOMPurify before rendering, exactly like the fetched article HTML.
 *
 * @param {string[]} blocks top-level HTML blocks
 * @param {object} settings stored AI settings
 * @param {{
 *   targetLanguage?: string,
 *   fromChunk?: number,
 *   signal?: AbortSignal,
 *   onBlockPreview?: (blockIndex: number, html: string) => void,
 *   onChunkDone?: (chunkIndex: number, html: string) => void,
 *   onProgress?: (done: number, total: number) => void,
 * }} [options]
 * @returns {Promise<{chunks: string[], language: string}>} translated chunk texts
 *   (only the ones this call produced, i.e. from `fromChunk` on)
 * @throws {Error} `no_content` plus every code chatCompletion can throw
 */
export async function translateArticleBlocks(blocks, settings, options = {}) {
  if (!isAiConfigured(settings)) throw new Error('not_configured')

  const list = (Array.isArray(blocks) ? blocks : []).filter(block => String(block || '').trim())
  if (list.length === 0) throw new Error('no_content')

  const target = LANGUAGE_NAMES[options.targetLanguage] ? options.targetLanguage : 'en'
  const targetName = LANGUAGE_NAMES[target]
  const plan = planTranslationChunks(list, TRANSLATION_CHUNK_CHARS)
  const from = Number.isInteger(options.fromChunk) && options.fromChunk > 0 ? options.fromChunk : 0
  const results = []

  const streamPiece = (html, previewStart, previewCount) => {
    const scanner = createHtmlBlockScanner()
    let previewed = 0

    return chatCompletionStream(buildTranslationMessages(html, targetName), settings, {
      signal: options.signal,
      maxTokens: TRANSLATION_MAX_TOKENS,
      // Half a silently missing chunk is worse than a retry — see below.
      failOnTruncation: true,
      onText: text => {
        for (const block of scanner.scan(text)) {
          // Previews stay inside the piece's own block range: a model that merges or
          // invents blocks must not overwrite a neighbouring paragraph. The
          // authoritative onChunkDone below corrects whatever the preview got wrong.
          if (previewed < previewCount) options.onBlockPreview?.(previewStart + previewed, block)
          previewed += 1
        }
      },
    })
  }

  for (let index = from; index < plan.length; index += 1) {
    const chunk = plan[index]

    let html
    try {
      html = stripCodeFence(await streamPiece(chunk.html, chunk.start, chunk.count))
    } catch (err) {
      // The model ran out of completion budget mid-chunk (a reasoning model that
      // cannot be reined in, or a pathologically markup-heavy passage). Retrying the
      // same request would cut off at the same place — so the chunk is redone block
      // by block, each small enough that no sane model runs out on it.
      if (!(err instanceof Error) || err.message !== 'truncated' || chunk.count === 1) throw err
      console.warn('[ai] chunk was cut off — retrying it block by block')

      const parts = []
      for (let offset = 0; offset < chunk.count; offset += 1) {
        parts.push(stripCodeFence(await streamPiece(list[chunk.start + offset], chunk.start + offset, 1)))
      }
      html = parts.join('')
    }

    results.push(html)
    options.onChunkDone?.(index, html)
    options.onProgress?.(index - from + 1, plan.length - from)
  }

  return { chunks: results, language: target }
}

/**
 * Convenience wrapper: whole article in, whole translation out (title included).
 * The reading view drives translateArticleBlocks directly for the streaming UI.
 *
 * The result is model output and therefore untrusted: the CALLER MUST run it through
 * DOMPurify before rendering, exactly like the fetched article HTML.
 *
 * @param {{html?: string, title?: string}} article
 * @param {object} settings stored AI settings
 * @param {{targetLanguage?: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<{html: string, title: string, language: string}>}
 * @throws {Error} `no_content` plus every code chatCompletion can throw
 */
export async function translateArticle(article, settings, options = {}) {
  if (!isAiConfigured(settings)) throw new Error('not_configured')

  const html = String(article?.html || '').trim()
  if (!html) throw new Error('no_content')

  const target = LANGUAGE_NAMES[options.targetLanguage] ? options.targetLanguage : 'en'
  const result = await translateArticleBlocks(splitHtmlBlocks(html), settings, {
    targetLanguage: target,
    signal: options.signal,
    onProgress: options.onProgress,
  })

  const translatedTitle = await translateText(article?.title, settings, {
    targetLanguage: target,
    signal: options.signal,
  })

  return { html: result.chunks.join(''), title: translatedTitle, language: target }
}

// Models like to wrap HTML in ```html fences however firmly you ask them not to.
function stripCodeFence(text) {
  const trimmed = String(text || '').trim()
  const match = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n?```$/i)
  return (match ? match[1] : trimmed).trim()
}

// ── Quell filter (per-feed AI filter) ───────────────────────────────────────
// The user writes, per feed, what they do not want to see ("keine Themen zur
// Astronomie"). On refresh the NEW items of that feed are shown to the model in
// one batch; it answers with nothing but the indices of the items to quell.
//
// Everything here is fail-open by contract: an unparseable answer is an empty
// array, and the caller (the store's refresh) treats every thrown error as
// "filter nothing". A broken provider must never cost the user articles.

// Titles say most of it; the snippet only disambiguates. ~200 chars per item keeps
// a 50-item batch around 3k tokens — cheap enough to run on every refresh.
export const QUELL_DESCRIPTION_CHARS = 200

// The refresh must never hang on the filter. 20 s is generous for a batch this
// small; whatever has not answered by then answers "nothing".
export const QUELL_TIMEOUT_MS = 20000

// A JSON array of at most a few dozen small integers.
const QUELL_MAX_TOKENS = 200

/**
 * Extracts the indices from a model answer, strictly and defensively.
 *
 * The contract asks for a bare JSON array, but models decorate: prose around it,
 * code fences, stringified numbers. We take the FIRST flat JSON array anywhere in
 * the text and keep only integers that index into the batch (deduplicated).
 * Anything that does not yield such an array — prose, objects, `null`, garbage —
 * is an empty array: fail-open, never fail-closed.
 *
 * @param {string} text the raw model answer
 * @param {number} count the batch size; indices outside [0, count) are dropped
 * @returns {number[]} sorted, deduplicated, in-range indices
 */
export function parseQuellIndices(text, count) {
  const size = Number.isInteger(count) && count > 0 ? count : 0
  if (size === 0) return []

  for (const match of String(text || '').matchAll(/\[[^\[\]]*\]/g)) {
    let parsed
    try {
      parsed = JSON.parse(match[0])
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue

    const indices = parsed
      // Accept "3" as 3 — a stringified index is unambiguous, and dropping it
      // would only make the filter weaker, not safer.
      .map(v => (typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN)))
      .filter(v => Number.isInteger(v) && v >= 0 && v < size)

    return [...new Set(indices)].sort((a, b) => a - b)
  }

  return []
}

function buildQuellMessages(filterPrompt, items) {
  const system = [
    'You are a content filter inside an RSS reader.',
    'The user has written, in their own words, what they do NOT want to see in this feed.',
    'You receive that wish and a numbered list of new articles (index, title, snippet).',
    'Decide for each article whether it matches what the user wants suppressed.',
    'Respond with ONLY a JSON array of the indices to suppress, e.g. [0,4] — or [] if none match.',
    'No markdown, no code fences, no explanation, no other text.',
    'When in doubt, do NOT suppress: only list articles that clearly match the wish.',
  ].join(' ')

  const list = items
    .map((item, index) => {
      const title = truncateForPrompt(String(item?.title || ''), QUELL_DESCRIPTION_CHARS)
      const description = truncateForPrompt(String(item?.description || ''), QUELL_DESCRIPTION_CHARS)
      return `${index}. ${title}${description ? ` — ${description}` : ''}`
    })
    .join('\n')

  const user = `The user's filter wish for this feed:\n${filterPrompt}\n\nNew articles:\n${list}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * Asks the model which of the given NEW feed items the user's filter wish quells.
 * One batch per feed per refresh — the caller is responsible for only passing
 * items that have never been rated before (rating costs money every time).
 *
 * @param {string} filterPrompt the user's free-text wish; blank means "filter off"
 * @param {Array<{title?: string, description?: string}>} items the new items, in batch order
 * @param {object} settings stored AI settings
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<number[]>} indices into `items` to quell; empty on any unparseable answer
 * @throws {Error} every code chatCompletion can throw — the caller fails open on all of them
 */
export async function quellFilterArticles(filterPrompt, items, settings, options = {}) {
  if (!isAiConfigured(settings)) throw new Error('not_configured')

  const prompt = String(filterPrompt || '').trim()
  const list = Array.isArray(items) ? items : []
  if (!prompt || list.length === 0) return []

  // Own timeout rather than relying on the provider: a refresh that waits forever
  // on the filter is worse than a refresh without the filter.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? QUELL_TIMEOUT_MS)

  try {
    const content = await chatCompletion(buildQuellMessages(prompt, list), settings, {
      signal: options.signal ?? controller.signal,
      maxTokens: QUELL_MAX_TOKENS,
      // Classification, not prose — the most deterministic answer is the right one.
      temperature: 0,
    })
    return parseQuellIndices(content, list.length)
  } finally {
    clearTimeout(timeout)
  }
}
