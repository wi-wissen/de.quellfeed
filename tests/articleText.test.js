import { describe, it, expect } from 'vitest'
import {
  extractArticleText,
  extractArticleMarkdown,
  collectSpeechBlocks,
  splitIntoUtterances,
  MAX_UTTERANCE_CHARS,
} from '../src/utils/articleText.js'

/** collectSpeechBlocks() walks a live document — so the test has to give it one. */
function body(html) {
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body
}

describe('extractArticleText', () => {
  it('separates paragraphs by a blank line so the engine pauses', () => {
    const text = extractArticleText('<p>Erster Absatz.</p><p>Zweiter Absatz.</p>')
    expect(text).toBe('Erster Absatz.\n\nZweiter Absatz.')
  })

  it('separates headings from the following paragraph', () => {
    const text = extractArticleText('<h2>Die Überschrift</h2><p>Der Text.</p>')
    expect(text).toBe('Die Überschrift\n\nDer Text.')
  })

  it('keeps inline markup as running text', () => {
    const text = extractArticleText('<p>Ein <strong>fettes</strong> und <em>kursives</em> Wort.</p>')
    expect(text).toBe('Ein fettes und kursives Wort.')
  })

  it('collapses whitespace inside a block', () => {
    const text = extractArticleText('<p>Viel\n   Platz\t hier.</p>')
    expect(text).toBe('Viel Platz hier.')
  })

  describe('captions', () => {
    const HTML = `
      <p>Vor dem Bild.</p>
      <figure>
        <img src="bild.jpg" alt="Ein Hund im Park">
        <figcaption>Ein Hund im Park, aufgenommen 2025.</figcaption>
      </figure>
      <p>Nach dem Bild.</p>
    `

    it('drops <figcaption> when skipCaptions is true (the default)', () => {
      const text = extractArticleText(HTML)
      expect(text).not.toContain('aufgenommen 2025')
      expect(text).toBe('Vor dem Bild.\n\nNach dem Bild.')
    })

    it('keeps <figcaption> when skipCaptions is false', () => {
      const text = extractArticleText(HTML, { skipCaptions: false })
      expect(text).toContain('Ein Hund im Park, aufgenommen 2025.')
    })

    it('drops a caption that hides in a .caption div instead of a <figcaption>', () => {
      const html = `
        <figure>
          <img src="bild.jpg">
          <div class="wp-caption-text">Foto: Jemand Anderes</div>
        </figure>
        <p>Der Artikel.</p>
      `
      expect(extractArticleText(html)).toBe('Der Artikel.')
    })

    it('drops a bare <p> caption inside an image figure', () => {
      const html = '<figure><img src="a.jpg"><p>Das ist die Unterschrift.</p></figure><p>Text.</p>'
      expect(extractArticleText(html)).toBe('Text.')
    })

    it('keeps a figure that wraps something other than an image', () => {
      const html = '<figure><pre>const a = 1</pre></figure>'
      expect(extractArticleText(html)).toContain('const a = 1')
    })
  })

  describe('alt texts', () => {
    it('never puts an alt text into the spoken text, images kept or not', () => {
      const html = '<p>Text.</p><img src="a.jpg" alt="ALTTEXT" title="TITELTEXT">'
      expect(extractArticleText(html)).toBe('Text.')
      expect(extractArticleText(html, { skipCaptions: false })).not.toContain('ALTTEXT')
    })

    it('never puts an alt text of a standalone figure image into the text', () => {
      const html = '<figure><img src="a.jpg" alt="ALTTEXT"><figcaption>Bildunterschrift</figcaption></figure>'
      const text = extractArticleText(html, { skipCaptions: false })
      expect(text).not.toContain('ALTTEXT')
      expect(text).toContain('Bildunterschrift')
    })

    it('never puts aria-label or title attributes into the text', () => {
      const html = '<p aria-label="ARIA" title="TITEL">Sichtbar.</p>'
      expect(extractArticleText(html)).toBe('Sichtbar.')
    })
  })

  it('never reads scripts or styles, even if they slip through the sanitizer', () => {
    const html = `
      <script>alert('BOESE')</script>
      <style>.x { color: RED }</style>
      <noscript>NOSCRIPT</noscript>
      <p>Nur das hier.</p>
    `
    const text = extractArticleText(html)
    expect(text).toBe('Nur das hier.')
    expect(text).not.toMatch(/BOESE|RED|NOSCRIPT/)
  })

  it('gives every list item its own pause', () => {
    const text = extractArticleText('<ul><li>Eins</li><li>Zwei</li></ul>')
    expect(text).toBe('Eins\n\nZwei')
  })

  it('returns an empty string for empty or text-free HTML', () => {
    expect(extractArticleText('')).toBe('')
    expect(extractArticleText(null)).toBe('')
    expect(extractArticleText(undefined)).toBe('')
    expect(extractArticleText('<img src="a.jpg" alt="nur ein Bild">')).toBe('')
    expect(extractArticleText('   ')).toBe('')
  })
})

describe('collectSpeechBlocks', () => {
  it('gives every block its own unit, in reading order', () => {
    const root = body('<h2>Die Überschrift</h2><p>Erster Absatz.</p><p>Zweiter Absatz.</p>')

    expect(collectSpeechBlocks(root).map(block => block.text)).toEqual([
      'Die Überschrift',
      'Erster Absatz.',
      'Zweiter Absatz.',
    ])
  })

  it('hands back the node each unit came from — the whole point of it', () => {
    const root = body('<p>Erster Absatz.</p><p>Zweiter Absatz.</p>')
    const blocks = collectSpeechBlocks(root)

    expect(blocks[0].element).toBe(root.querySelectorAll('p')[0])
    expect(blocks[1].element).toBe(root.querySelectorAll('p')[1])
  })

  it('does not mutate the document it is shown', () => {
    const root = body('<p>Text.</p><figure><img src="a.jpg"><figcaption>Bildunterschrift</figcaption></figure>')

    collectSpeechBlocks(root)

    // The reading view is showing this document — the image must still be on screen.
    expect(root.querySelector('img')).not.toBeNull()
    expect(root.querySelector('figcaption')).not.toBeNull()
  })

  it('skips images, image figures and captions', () => {
    const root = body(`
      <p>Vor dem Bild.</p>
      <figure><img src="a.jpg" alt="ALTTEXT"><figcaption>Foto: Jemand</figcaption></figure>
      <div class="wp-caption-text">Foto: Jemand Anderes</div>
      <p>Nach dem Bild.</p>
    `)

    const text = collectSpeechBlocks(root).map(block => block.text)
    expect(text).toEqual(['Vor dem Bild.', 'Nach dem Bild.'])
    expect(text.join(' ')).not.toContain('ALTTEXT')
  })

  it('never reads scripts, styles or attributes', () => {
    const root = body('<script>alert("BOESE")</script><p aria-label="ARIA" title="TITEL">Sichtbar.</p>')

    expect(collectSpeechBlocks(root).map(block => block.text)).toEqual(['Sichtbar.'])
  })

  it('keeps a paragraph with a <br> as ONE unit', () => {
    const root = body('<p>Erste Zeile.<br>Zweite Zeile.</p>')
    const blocks = collectSpeechBlocks(root)

    // Two units would mean two highlights and two taps for one paragraph — but the
    // newline stays in the text, so the engine still pauses.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('Erste Zeile.\nZweite Zeile.')
  })

  it('gives every list item its own unit', () => {
    const root = body('<ul><li>Eins</li><li>Zwei</li></ul>')
    const blocks = collectSpeechBlocks(root)

    expect(blocks.map(block => block.text)).toEqual(['Eins', 'Zwei'])
    expect(blocks[0].element.tagName).toBe('LI')
  })

  it('returns an empty list for an empty or text-free document', () => {
    expect(collectSpeechBlocks(body(''))).toEqual([])
    expect(collectSpeechBlocks(body('<img src="a.jpg" alt="nur ein Bild">'))).toEqual([])
    expect(collectSpeechBlocks(null)).toEqual([])
  })

  it('reads the same words as extractArticleText', () => {
    const html = '<h1>Titel</h1><p>Ein <strong>fetter</strong> Absatz.</p><ul><li>Eins</li></ul>'

    const blocks = collectSpeechBlocks(body(html)).map(block => block.text).join('\n\n')
    expect(blocks).toBe(extractArticleText(html))
  })
})

describe('extractArticleMarkdown', () => {
  it('keeps headings, paragraphs, lists and links', () => {
    const html = `
      <h1>Titel</h1>
      <p>Ein <a href="https://example.com">Link</a> im Text.</p>
      <ul><li>Eins</li><li>Zwei</li></ul>
    `
    const md = extractArticleMarkdown(html)
    expect(md).toContain('# Titel')
    expect(md).toContain('[Link](https://example.com)')
    expect(md).toContain('- Eins')
    expect(md).toContain('- Zwei')
  })

  it('numbers ordered lists', () => {
    const md = extractArticleMarkdown('<ol><li>Erst</li><li>Dann</li></ol>')
    expect(md).toBe('1. Erst\n2. Dann')
  })

  it('keeps emphasis and code', () => {
    const md = extractArticleMarkdown('<p><strong>Fett</strong> und <code>code()</code>.</p>')
    expect(md).toContain('**Fett**')
    expect(md).toContain('`code()`')
  })

  it('copies images and captions in the "everything" mode', () => {
    const html = '<figure><img src="a.jpg" alt="Ein Hund"><figcaption>Foto: Wer auch immer</figcaption></figure>'
    const md = extractArticleMarkdown(html, { skipCaptions: false, skipImages: false })
    expect(md).toContain('![Ein Hund](a.jpg)')
    expect(md).toContain('*Foto: Wer auch immer*')
  })

  it('drops images and captions by default', () => {
    const html = '<figure><img src="a.jpg" alt="Ein Hund"><figcaption>Foto: Wer auch immer</figcaption></figure><p>Text.</p>'
    const md = extractArticleMarkdown(html)
    expect(md).toBe('Text.')
    expect(md).not.toContain('Ein Hund')
  })

  it('returns an empty string for empty HTML', () => {
    expect(extractArticleMarkdown('')).toBe('')
    expect(extractArticleMarkdown(null)).toBe('')
  })
})

describe('splitIntoUtterances', () => {
  it('returns an empty array for empty input', () => {
    expect(splitIntoUtterances('')).toEqual([])
    expect(splitIntoUtterances(null)).toEqual([])
    expect(splitIntoUtterances('   \n\n  ')).toEqual([])
  })

  it('keeps a short text in one piece', () => {
    expect(splitIntoUtterances('Ein kurzer Satz.')).toEqual(['Ein kurzer Satz.'])
  })

  it('keeps the paragraph pause inside an utterance', () => {
    expect(splitIntoUtterances('Eins.\n\nZwei.')).toEqual(['Eins.\n\nZwei.'])
  })

  it('stays under the default limit for a long article', () => {
    const paragraph = `${'Ein durchaus normaler deutscher Satz mit Inhalt. '.repeat(30).trim()}`
    const article = Array.from({ length: 20 }, () => paragraph).join('\n\n')

    const utterances = splitIntoUtterances(article)
    expect(utterances.length).toBeGreaterThan(1)
    utterances.forEach(utterance => expect(utterance.length).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS))
  })

  it('splits on sentence boundaries, never mid-word', () => {
    const text = 'Der erste Satz ist hier. Der zweite Satz folgt! Und der dritte? Ja, der auch.'
    const utterances = splitIntoUtterances(text, 40)

    utterances.forEach(utterance => {
      expect(utterance.length).toBeLessThanOrEqual(40)
      // Every chunk ends where a sentence ends.
      expect(utterance).toMatch(/[.!?]$/)
    })
    // Nothing was lost and no word was torn apart.
    expect(utterances.join(' ')).toBe(text)
  })

  it('does not tear words apart when a single sentence exceeds the limit', () => {
    const words = Array.from({ length: 60 }, (_, i) => `wort${i}`)
    const sentence = `${words.join(' ')}.`

    const utterances = splitIntoUtterances(sentence, 50)

    expect(utterances.length).toBeGreaterThan(1)
    utterances.forEach(utterance => expect(utterance.length).toBeLessThanOrEqual(50))
    // Re-joining reproduces the sentence exactly: every word survived whole.
    expect(utterances.join(' ')).toBe(sentence)
  })

  it('does not chop an unbreakable token forever (the pathological case)', () => {
    // A 500-character "word" with no space to cut at, limit 50.
    const monster = 'x'.repeat(500)

    const utterances = splitIntoUtterances(monster, 50)

    expect(utterances).toHaveLength(10) // 500 / 50 — finite, not endless
    utterances.forEach(utterance => expect(utterance.length).toBeLessThanOrEqual(50))
    expect(utterances.join('')).toBe(monster)
  })

  it('terminates even with an absurd limit', () => {
    expect(splitIntoUtterances('abcdef', 1)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(splitIntoUtterances('abc', 0)).toBeInstanceOf(Array)
  })

  it('packs whole paragraphs together while they fit', () => {
    const utterances = splitIntoUtterances('Eins.\n\nZwei.\n\nDrei.', 12)
    expect(utterances).toEqual(['Eins.\n\nZwei.', 'Drei.'])
  })
})
