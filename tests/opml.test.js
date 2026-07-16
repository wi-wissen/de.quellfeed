import { describe, it, expect } from 'vitest'
import { exportOpml, parseOpml } from '../src/utils/opml.js'

const SAMPLE_FEEDS = [
  { id: '1', title: 'Spiegel Online', url: 'https://www.spiegel.de/schlagzeilen/index.rss' },
  { id: '2', title: 'Heise & Co', url: 'https://www.heise.de/rss/heise-atom.xml' },
]

describe('exportOpml', () => {
  it('produces valid XML with all feeds', () => {
    const xml = exportOpml(SAMPLE_FEEDS)
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<opml')
    expect(xml).toContain('Spiegel Online')
    expect(xml).toContain('www.spiegel.de')
  })

  it('escapes ampersands in titles', () => {
    const xml = exportOpml(SAMPLE_FEEDS)
    expect(xml).toContain('Heise &amp; Co')
    expect(xml).not.toContain('Heise & Co')
  })
})

describe('parseOpml', () => {
  it('round-trips through export/import', () => {
    const xml = exportOpml(SAMPLE_FEEDS)
    const parsed = parseOpml(xml)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].url).toBe(SAMPLE_FEEDS[0].url)
    expect(parsed[1].url).toBe(SAMPLE_FEEDS[1].url)
  })

  it('handles missing title gracefully', () => {
    const xml = `<?xml version="1.0"?><opml><body>
      <outline xmlUrl="https://example.com/rss"/>
    </body></opml>`
    const parsed = parseOpml(xml)
    expect(parsed[0].url).toBe('https://example.com/rss')
  })
})
