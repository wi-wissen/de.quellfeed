import { describe, it, expect } from 'vitest'
import { Readability } from '@mozilla/readability'
import { sanitizeArticleHtml } from '../src/utils/sanitize.js'
import { splitHtmlBlocks, planTranslationChunks } from '../src/utils/htmlBlocks.js'
import { translateArticleBlocks, translateText, TRANSLATION_CHUNK_CHARS } from '../src/utils/ai.js'

/**
 * LIVE end-to-end check on the exact article the paragraph-streaming was reported
 * broken with. Needs the network and QUELL_LIVE_KEY; skipped everywhere else.
 */
const KEY = process.env.QUELL_LIVE_KEY || ''
const ARTICLE_URL = 'https://www.irishtimes.com/world/europe/2026/07/08/ai-software-that-generates-rage-bait-developed-by-germanys-far-right-afd/'

const SETTINGS = {
  provider: 'openrouter',
  baseUrl: '',
  apiKey: KEY,
  model: 'deepseek/deepseek-v4-flash',
}

describe.skipIf(!KEY)('live: the Irish Times article, whole pipeline', () => {
  it('splits into real paragraphs and translates them completely', async () => {
    const res = await fetch(ARTICLE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    expect(res.status).toBe(200)
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    const html = sanitizeArticleHtml(new Readability(doc).parse()?.content || '')

    const blocks = splitHtmlBlocks(html)
    console.log('blocks:', blocks.length, '— sizes:', blocks.map(b => b.length).join(', '))
    // The wrapper <div class="page"> must be dissolved into actual paragraphs.
    expect(blocks.length).toBeGreaterThan(5)

    const plan = planTranslationChunks(blocks, TRANSLATION_CHUNK_CHARS)
    const previews = []
    const result = await translateArticleBlocks(blocks, SETTINGS, {
      targetLanguage: 'de',
      onBlockPreview: (index, blockHtml) => previews.push([index, blockHtml.length]),
    })

    const joined = result.chunks.join('')
    console.log('chunks:', plan.length, '— previews:', previews.length, '— result length:', joined.length)
    console.log('tail:', joined.slice(-160))

    // Nothing silently missing: the translation covers the whole article
    // (German runs a bit longer; anything below ~80% means lost paragraphs).
    expect(joined.length).toBeGreaterThan(html.length * 0.8)
    // Paragraph count preserved.
    expect((joined.match(/<p[ >]/g) || []).length).toBe((html.match(/<p[ >]/g) || []).length)
    // Paragraph-wise previews actually happened.
    expect(previews.length).toBeGreaterThan(3)
    expect(joined.toLowerCase()).toMatch(/deutschland|partei|software/)

    const title = await translateText(
      'AI software that generates rage bait developed by Germany’s far-right AfD',
      SETTINGS,
      { targetLanguage: 'de' },
    )
    console.log('title:', title)
    expect(title.length).toBeGreaterThan(10)
  }, 240000)
})
