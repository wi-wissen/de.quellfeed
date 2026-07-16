import { describe, it, expect } from 'vitest'
import { chatCompletionStream, translateArticleBlocks, translateText } from '../src/utils/ai.js'

/**
 * LIVE tests against the real OpenRouter API — they cost (a tiny amount of) real
 * credit and need the network, so they only run when a key is provided:
 *
 *   QUELL_LIVE_KEY=sk-or-… npx vitest run tests/liveTranslate.test.js
 *
 * Never put a key into this file; the environment variable is the only way in.
 * In CI and normal runs the whole suite is skipped.
 */
const KEY = process.env.QUELL_LIVE_KEY || ''

const SETTINGS = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: KEY,
  model: 'deepseek/deepseek-v4-flash',
}

describe.skipIf(!KEY)('live: OpenRouter streaming', () => {
  it('actually streams — the text grows across many onText calls', async () => {
    const sizes = []
    const content = await chatCompletionStream(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Count from 1 to 30 as words, one per line: one, two, …' },
      ],
      SETTINGS,
      { onText: text => sizes.push(text.length), maxTokens: 300 },
    )

    expect(content.length).toBeGreaterThan(50)
    // A buffered (non-streaming) response would arrive as ONE call.
    expect(sizes.length).toBeGreaterThan(3)
    // Monotonically growing — full-text-so-far semantics.
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1])
  }, 90000)

  it('translates blocks with live paragraph previews in order', async () => {
    const previews = []
    const result = await translateArticleBlocks(
      [
        '<p>The sun rose over the quiet town.</p>',
        '<p>Nobody was awake yet.</p>',
        '<h2>A new day</h2>',
      ],
      SETTINGS,
      {
        targetLanguage: 'de',
        onBlockPreview: (index, html) => previews.push([index, html]),
      },
    )

    const joined = result.chunks.join('')
    // Structure preserved: same tags, same count.
    expect(joined.match(/<p>/g)).toHaveLength(2)
    expect(joined).toContain('<h2>')
    expect(joined).not.toContain('```')
    // Actually German now.
    expect(joined.toLowerCase()).toMatch(/sonne|stadt|tag/)

    // Previews arrived in document order and inside the block range.
    expect(previews.length).toBeGreaterThan(0)
    expect(previews.map(p => p[0])).toEqual(previews.map((_, i) => i))
    expect(previews.every(p => p[0] >= 0 && p[0] < 3)).toBe(true)
  }, 120000)

  it('translates a headline', async () => {
    const title = await translateText('The sun rises over the quiet town', SETTINGS, {
      targetLanguage: 'de',
    })

    expect(title.length).toBeGreaterThan(5)
    expect(title.toLowerCase()).toMatch(/sonne|stadt/)
  }, 60000)
})
