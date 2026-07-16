import { describe, expect, it } from 'vitest'
import {
  describeSetupConfig,
  encodeSetupPayload,
  parseSetupLink,
} from '../src/utils/setupLink.js'

function link(payload, scheme = 'de.quellfeed://setup') {
  return `${scheme}#${encodeSetupPayload(payload)}`
}

const VALID = { v: 1, ai: { provider: 'openrouter', baseUrl: '', apiKey: 'sk-or-abcdef123456', model: 'deepseek/deepseek-v4-flash' } }

describe('parseSetupLink', () => {
  it('accepts a valid app-scheme link and keeps only the four known fields', () => {
    const patch = parseSetupLink(link({ ...VALID, extra: 'smuggled', ai: { ...VALID.ai, evil: 'x' } }))

    expect(patch.ai).toEqual({
      provider: 'openrouter',
      baseUrl: '',
      apiKey: 'sk-or-abcdef123456',
      model: 'deepseek/deepseek-v4-flash',
    })
    expect(patch.ai.evil).toBeUndefined()
  })

  it('accepts the https spellings as a fallback for the app scheme', () => {
    expect(parseSetupLink(link(VALID, 'https://quellfeed.de/setup'))).not.toBeNull()
    expect(parseSetupLink(link(VALID, 'https://quellfeed.de/setup-ai'))).not.toBeNull()
    expect(parseSetupLink(link(VALID, 'https://quellfeed.de/setup-ai.html'))).not.toBeNull()
  })

  it('returns null for URLs that are no setup link at all', () => {
    expect(parseSetupLink('https://example.com/article')).toBeNull()
    expect(parseSetupLink('de.quellfeed://something-else#abc')).toBeNull()
    expect(parseSetupLink('')).toBeNull()
    expect(parseSetupLink(null)).toBeNull()
  })

  it('throws on a damaged payload instead of silently ignoring it', () => {
    expect(() => parseSetupLink('de.quellfeed://setup#not-base64!!')).toThrow('invalid_setup_link')
    expect(() => parseSetupLink(`de.quellfeed://setup#${btoa('"just a string"')}`)).toThrow('invalid_setup_link')
  })

  it('rejects unknown versions and unknown providers', () => {
    expect(() => parseSetupLink(link({ ...VALID, v: 2 }))).toThrow('invalid_setup_link')
    expect(() => parseSetupLink(link({ v: 1, ai: { ...VALID.ai, provider: 'evilcorp' } }))).toThrow('invalid_setup_link')
  })

  it('rejects a missing key — the whole point of the link is carrying one', () => {
    expect(() => parseSetupLink(link({ v: 1, ai: { ...VALID.ai, apiKey: '' } }))).toThrow('invalid_setup_link')
  })

  it('requires a plausible base URL for the custom provider and none for presets', () => {
    const custom = { provider: 'custom', baseUrl: 'https://my.example/v1', apiKey: 'k-123456', model: 'llama-3.3' }
    expect(parseSetupLink(link({ v: 1, ai: custom })).ai.baseUrl).toBe('https://my.example/v1')

    expect(() => parseSetupLink(link({ v: 1, ai: { ...custom, baseUrl: '' } }))).toThrow('invalid_setup_link')
    expect(() => parseSetupLink(link({ v: 1, ai: { ...custom, baseUrl: 'ftp://x' } }))).toThrow('invalid_setup_link')
    // A preset ignores any base URL the payload tries to bring along.
    expect(parseSetupLink(link({ v: 1, ai: { ...VALID.ai, baseUrl: 'https://attacker.example' } })).ai.baseUrl).toBe('')
  })

  it('rejects HTML in the model name — the confirm dialog renders HTML', () => {
    expect(() =>
      parseSetupLink(link({ v: 1, ai: { ...VALID.ai, model: '<img src=x onerror=alert(1)>' } }))
    ).toThrow('invalid_setup_link')
  })

  it('survives unicode in the key', () => {
    const ai = { ...VALID.ai, apiKey: 'sk-ü🔑-abcdef' }
    expect(parseSetupLink(link({ v: 1, ai })).ai.apiKey).toBe('sk-ü🔑-abcdef')
  })
})

describe('describeSetupConfig', () => {
  it('masks the key down to its ending', () => {
    const shown = describeSetupConfig(VALID.ai)
    expect(shown.keyEnding).toBe('…3456')
    expect(shown.keyEnding).not.toContain('abcdef')
  })

  it('still shows an ending for a short test key — "ends in …" with nothing after is a bug', () => {
    expect(describeSetupConfig({ ...VALID.ai, apiKey: '123' }).keyEnding).toBe('…123')
  })

  it('shows the effective base URL for presets — the user must see where data goes', () => {
    expect(describeSetupConfig(VALID.ai).baseUrl).toContain('openrouter.ai')
    expect(
      describeSetupConfig({ provider: 'custom', baseUrl: 'https://my.example/v1', apiKey: 'k-12345', model: 'm' }).baseUrl
    ).toBe('https://my.example/v1')
  })

  it('HTML-escapes everything it returns — Framework7 dialogs render HTML', () => {
    const shown = describeSetupConfig({
      provider: 'custom',
      baseUrl: 'https://x.example/<b>?a=1&b=2',
      apiKey: 'k-12345',
      model: 'model',
    })
    expect(shown.baseUrl).not.toContain('<b>')
    expect(shown.baseUrl).toContain('&lt;b&gt;')
  })
})
