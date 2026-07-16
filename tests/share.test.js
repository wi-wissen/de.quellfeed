import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shareArticle, buildQrDataUrl, copyLink } from '../src/utils/share.js'
import { Share } from '@capacitor/share'
import { f7 } from 'framework7-vue'

vi.mock('@capacitor/share', () => ({
  Share: {
    canShare: vi.fn(),
    share: vi.fn(),
  },
}))

vi.mock('framework7-vue', () => ({
  f7: {
    sheet: { create: vi.fn() },
    toast: { show: vi.fn() },
  },
}))

const ARTICLE = {
  title: 'Ein Artikel',
  url: 'https://example.com/story',
}

/** Stand-in for vue-i18n's t(): echoes the key, so nothing can be mistaken for a literal. */
const t = key => `[[${key}]]`

/** The sheet instance f7.sheet.create() hands back. */
function stubSheet() {
  const sheet = { open: vi.fn(), close: vi.fn(), destroy: vi.fn(), el: null }
  f7.sheet.create.mockReturnValue(sheet)
  return sheet
}

/** The content HTML passed to the single f7.sheet.create() call. */
function sheetContent() {
  return f7.sheet.create.mock.calls[0][0].content
}

beforeEach(() => {
  vi.clearAllMocks()
  Share.canShare.mockResolvedValue({ value: true })
  Share.share.mockResolvedValue({})
})

describe('buildQrDataUrl', () => {
  it('renders a PNG data URL for a real URL', async () => {
    const dataUrl = await buildQrDataUrl('https://example.com/story')

    expect(dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(dataUrl.length).toBeGreaterThan(100)
  })

  it('encodes different URLs differently', async () => {
    const a = await buildQrDataUrl('https://example.com/a')
    const b = await buildQrDataUrl('https://example.com/b')

    expect(a).not.toBe(b)
  })
})

describe('shareArticle — native path', () => {
  it('shares natively when canShare() is true, and shows no sheet', async () => {
    stubSheet()

    const result = await shareArticle(ARTICLE, t)

    expect(result).toBe('shared')
    expect(Share.share).toHaveBeenCalledWith({
      title: 'Ein Artikel',
      url: 'https://example.com/story',
      dialogTitle: 'Ein Artikel',
    })
    expect(f7.sheet.create).not.toHaveBeenCalled()
  })
})

describe('shareArticle — fallback path', () => {
  it('shows the fallback sheet when canShare() is false', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    const sheet = stubSheet()

    const result = await shareArticle(ARTICLE, t)

    expect(result).toBe('fallback')
    expect(Share.share).not.toHaveBeenCalled()
    expect(f7.sheet.create).toHaveBeenCalledTimes(1)
    expect(sheet.open).toHaveBeenCalled()
  })

  it('shows the fallback sheet when share() throws "not available"', async () => {
    // What the Capacitor web shim throws: CapacitorException, code UNAVAILABLE.
    const unavailable = Object.assign(new Error('Share API not available in this browser'), {
      code: 'UNAVAILABLE',
    })
    Share.share.mockRejectedValue(unavailable)
    const sheet = stubSheet()

    const result = await shareArticle(ARTICLE, t)

    expect(result).toBe('fallback')
    expect(sheet.open).toHaveBeenCalled()
  })

  it('shows the fallback sheet when the browser blocks share without a user gesture', async () => {
    Share.share.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    )
    stubSheet()

    expect(await shareArticle(ARTICLE, t)).toBe('fallback')
    expect(f7.sheet.create).toHaveBeenCalledTimes(1)
  })

  it('puts a QR code, the URL and both actions in the sheet', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()

    await shareArticle(ARTICLE, t)
    const content = sheetContent()

    expect(content).toContain('data:image/png;base64,')
    expect(content).toContain('https://example.com/story')
    expect(content).toContain('share-sheet__copy')
    expect(content).toContain('share-sheet__open')
  })

  it('keeps the QR code dark-on-white so it stays scannable in dark mode', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()

    await shareArticle(ARTICLE, t)

    // The QR image sits on an explicitly white card, never on a themed background.
    expect(sheetContent()).toContain('background:#ffffff')
  })

  it('offers a way out that does not need a swipe or a backdrop tap', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()

    await shareArticle(ARTICLE, t)
    const content = sheetContent()

    // F7 closes anything carrying .sheet-close; the hook is also wired up by hand.
    expect(content).toContain('sheet-close')
    expect(content).toContain('share-sheet__close')
  })

  it('does nothing when the article has no URL', async () => {
    stubSheet()

    expect(await shareArticle({ title: 'Kein Link' }, t)).toBe('noop')
    expect(Share.share).not.toHaveBeenCalled()
    expect(f7.sheet.create).not.toHaveBeenCalled()
  })
})

/*
 * The sheet used to be cut off at the bottom: framework7 gives .sheet-modal a flat
 * `height: var(--f7-sheet-height)` (260px) with `overflow: hidden`, so the QR code, the
 * URL and the buttons — some 550px of content — were clipped to the first 260 pixels.
 *
 * These tests pin the structure that undoes that. They are checking a string, not a
 * layout, so they can't prove the sheet renders correctly — but they do fail loudly if
 * someone drops the parts of the markup that the fix depends on.
 */
describe('shareArticle — the fallback sheet sizes itself to its content', () => {
  beforeEach(async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()
    await shareArticle(ARTICLE, t)
  })

  it('overrides framework7\'s fixed sheet height so nothing is clipped', () => {
    const sheetTag = sheetContent().match(/<div class="sheet-modal[^>]*>/)[0]

    // Inline beats the `.sheet-modal { height: var(--f7-sheet-height) }` class rule.
    expect(sheetTag).toContain('height:auto')
  })

  it('keeps the framework7 sheet structure F7 needs to lay the sheet out', () => {
    const content = sheetContent()

    expect(content).toContain('class="sheet-modal-inner"')
    // F7's own auto-height sheets (see its color picker) scroll via a .page-content.
    expect(content).toMatch(/<div class="page-content"/)
  })

  it('scrolls the content instead of clipping it when the screen is too short', () => {
    const pageContentTag = sheetContent().match(/<div class="page-content"[^>]*>/)[0]

    // .page-content is already overflow:auto — capping its height is what makes it scroll,
    // which is the difference between a landscape phone scrolling and a landscape phone
    // showing half a QR code.
    expect(pageContentTag).toMatch(/max-height:\s*\d+dvh/)
    // …with a plain-vh line first, for browsers that don't know dvh.
    expect(pageContentTag).toMatch(/max-height:\s*\d+vh/)
  })

  it('lets the QR code shrink to a narrow phone but not grow past its native size', () => {
    const img = sheetContent().match(/<img[^>]*>/)[0]

    expect(img).toContain('width:100%')
    expect(img).toContain('max-width:260px')
    // Square whatever the width, and no fixed pixel height to fight the scaling.
    expect(img).toContain('height:auto')
    expect(img).toContain('aspect-ratio:1/1')
    expect(img).not.toMatch(/style="[^"]*height:\s*260px/)
  })
})

describe('shareArticle — user cancellation', () => {
  it('shows no sheet when the user dismisses the native sheet (iOS/Android)', async () => {
    // Both SharePlugin.swift and SharePlugin.java reject with exactly this message.
    Share.share.mockRejectedValue(new Error('Share canceled'))
    stubSheet()

    const result = await shareArticle(ARTICLE, t)

    expect(result).toBe('cancelled')
    expect(f7.sheet.create).not.toHaveBeenCalled()
  })

  it('shows no sheet when the user dismisses the Web Share popup (AbortError)', async () => {
    Share.share.mockRejectedValue(
      Object.assign(new Error('Share canceled'), { name: 'AbortError' }),
    )
    stubSheet()

    const result = await shareArticle(ARTICLE, t)

    expect(result).toBe('cancelled')
    expect(f7.sheet.create).not.toHaveBeenCalled()
  })

  it('treats a cancellation as a cancellation even with British spelling', async () => {
    Share.share.mockRejectedValue(new Error('Share cancelled'))
    stubSheet()

    expect(await shareArticle(ARTICLE, t)).toBe('cancelled')
    expect(f7.sheet.create).not.toHaveBeenCalled()
  })
})

describe('shareArticle — texts come from t()', () => {
  it('takes every label from the translation function', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()

    await shareArticle(ARTICLE, t)
    const content = sheetContent()

    expect(content).toContain('[[share.title]]')
    expect(content).toContain('[[share.copy]]')
    expect(content).toContain('[[share.openInBrowser]]')
    expect(content).toContain('[[share.scanHint]]')
    // The close button reuses the existing common.cancel key rather than inventing one.
    expect(content).toContain('[[common.cancel]]')
  })

  it('has no hardcoded German or English UI copy in the sheet', async () => {
    Share.canShare.mockResolvedValue({ value: false })
    stubSheet()

    await shareArticle(ARTICLE, t)
    const content = sheetContent()

    const literals = [
      'Kopieren', 'Copy link', 'Link kopieren',
      'Im Browser öffnen', 'Open in browser',
      'Teilen', 'Abbrechen', 'Cancel',
    ]
    for (const literal of literals) {
      expect(content).not.toContain(literal)
    }
  })
})

describe('copyLink', () => {
  it('uses the Clipboard API and toasts share.copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const copied = await copyLink('https://example.com/story', t)

    expect(copied).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://example.com/story')
    expect(f7.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[[share.copied]]' }),
    )

    vi.unstubAllGlobals()
  })

  it('falls back to execCommand when the Clipboard API is missing', async () => {
    vi.stubGlobal('navigator', {})
    document.execCommand = vi.fn().mockReturnValue(true)

    const copied = await copyLink('https://example.com/story', t)

    expect(copied).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(f7.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[[share.copied]]' }),
    )

    vi.unstubAllGlobals()
  })

  it('reports failure and stays quiet when nothing can copy', async () => {
    vi.stubGlobal('navigator', {})
    document.execCommand = vi.fn().mockReturnValue(false)

    const copied = await copyLink('https://example.com/story', t)

    expect(copied).toBe(false)
    expect(f7.toast.show).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })
})
