import { Share } from '@capacitor/share'
import { f7 } from 'framework7-vue'
import QRCode from 'qrcode'

/**
 * Sharing an article has two very different lives.
 *
 * On a phone there is a real share sheet, so we hand the URL to the OS and get out
 * of the way. In a desktop browser there often is not: Firefox has no Web Share API
 * at all, and Chrome only exposes it on some platforms. The Capacitor web shim then
 * throws, and the old call sites swallowed that in an empty `catch {}` — you clicked
 * "share" and absolutely nothing happened.
 *
 * So when the platform can't share, we share the only way a desktop can: we show the
 * link, offer to copy it, and paint a QR code so the link can be walked over to a
 * phone. All of it offline — the app is offline-first and Capacitor has no CDN.
 */

/**
 * Dark modules on a white field, always — regardless of the app theme.
 *
 * It is tempting to tint the QR code with --q-text / --q-bg so it blends into dark
 * mode, but an inverted (light-on-dark) QR code is rejected by a large share of
 * scanners, including some stock camera apps. A readable code that ignores the theme
 * beats a beautiful code that won't scan, so the sheet gives it a white card to sit
 * on instead.
 */
const QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 260,
  color: { dark: '#000000', light: '#ffffff' },
}

/**
 * PNG data-URL of `url`. Exported on its own so it can be tested without a sheet.
 */
export async function buildQrDataUrl(url) {
  return QRCode.toDataURL(String(url), QR_OPTIONS)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Did the user just back out of the native share sheet?
 *
 * This matters, because a dismissal must NOT drop them into our fallback sheet — they
 * said no, showing them a second sheet is exactly the nagging we're trying to avoid.
 * A dismissal and a "this platform can't share" both arrive as a rejected promise, so
 * we have to tell them apart by hand:
 *
 *   - iOS + Android: `call.reject("Share canceled")` on dismissal — an Error whose
 *     message is literally "Share canceled" (see SharePlugin.swift / SharePlugin.java
 *     in @capacitor/share). There is no error code, so the message is all we have.
 *   - Web: navigator.share() rejects with a DOMException named "AbortError" when the
 *     user closes the browser/OS share popup.
 *
 * Everything else — the web shim's CapacitorException (code "UNAVAILABLE"), a
 * NotAllowedError from a missing user gesture, a TypeError on bad payload — is not a
 * dismissal and does deserve the fallback.
 */
function isUserCancel(error) {
  if (!error) return false
  if (error.name === 'AbortError') return true
  return /cancel+ed/i.test(String(error.message || error))
}

/**
 * Copy to the clipboard, with a route for browsers that don't do the async Clipboard
 * API (or refuse it outside a secure context, which the Capacitor webview can hit).
 * Returns whether it worked, so the caller decides what to say.
 */
export async function copyLink(url, t) {
  let copied = false

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
      copied = true
    }
  } catch {
    copied = false
  }

  if (!copied) {
    // Deprecated, but it is the only thing that works when the Clipboard API is out.
    try {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand?.('copy') ?? false
      document.body.removeChild(textarea)
    } catch {
      copied = false
    }
  }

  if (copied) {
    f7.toast?.show({ text: t('share.copied'), closeTimeout: 2000 })
  }

  return copied
}

/**
 * The QR code is the tallest thing in the sheet, so it decides the sizing rules.
 *
 * `width: 100%` + a max-width lets it be exactly as big as it should be: capped at its
 * native 260px on a desktop (bigger buys nothing, a QR code is not a photo), and free
 * to shrink down to the width of a narrow phone rather than overflowing it. The natural
 * width/height attributes stay on the <img> so the layout doesn't jump before the data
 * URL paints; `height: auto` + `aspect-ratio` keep it square while CSS drives the width.
 */
const QR_MAX_PX = 260
const QR_CARD_PADDING_PX = 12
const QR_CARD_MAX_PX = QR_MAX_PX + QR_CARD_PADDING_PX * 2

/**
 * How tall the sheet is allowed to get before its content starts scrolling.
 *
 * dvh, where it exists, measures the viewport as it actually is right now, so a mobile
 * browser's collapsing URL bar can't make the sheet taller than the screen. The plain
 * vh line before it is the fallback for browsers that don't know dvh — the declarations
 * are in cascade order, so the last one a browser understands wins.
 */
const SHEET_MAX_HEIGHT = 'max-height:80vh;max-height:80dvh;'

function buildSheetHtml({ url, qrDataUrl }, t) {
  const safeUrl = escapeHtml(url)

  // The QR code sits on its own white card so it stays scannable in dark themes.
  const qr = qrDataUrl
    ? `<div style="display:flex;justify-content:center;">
         <div style="background:#ffffff;padding:${QR_CARD_PADDING_PX}px;border-radius:12px;line-height:0;box-sizing:border-box;width:100%;max-width:${QR_CARD_MAX_PX}px;">
           <img src="${escapeHtml(qrDataUrl)}" alt="${escapeHtml(t('share.title'))}" width="${QR_MAX_PX}" height="${QR_MAX_PX}" style="display:block;width:100%;height:auto;max-width:${QR_MAX_PX}px;aspect-ratio:1/1;" />
         </div>
       </div>`
    : ''

  /*
   * The structure here is not decoration, it is the whole fix — see openShareFallbackSheet.
   *
   *   .sheet-modal      height:auto  — beats framework7's fixed --f7-sheet-height
   *     .sheet-modal-inner           — F7 wants this wrapper; height:100% of an auto
   *                                    parent resolves to auto, so it hugs its content
   *       .page-content              — F7's scroll container: overflow:auto and a
   *                                    padding-bottom that already includes the bottom
   *                                    safe area, so the last button clears the home bar
   */
  return `
    <div class="sheet-modal share-sheet" style="height:auto;">
      <div class="sheet-modal-inner">
        <div class="page-content" style="height:auto;${SHEET_MAX_HEIGHT}">
          <div class="block">
            <div class="share-sheet__handle" style="width:36px;height:4px;border-radius:2px;margin:0 auto 12px;background:currentColor;opacity:0.2;"></div>
            <p style="text-align:center;font-weight:600;margin:0 0 12px;">${escapeHtml(t('share.title'))}</p>
            ${qr}
            <p style="text-align:center;color:var(--q-text-muted);margin:12px 0 16px;">${escapeHtml(t('share.scanHint'))}</p>
            <p style="text-align:center;word-break:break-all;color:var(--q-text-muted);margin:0 0 16px;">${safeUrl}</p>
            <button class="button button-fill share-sheet__copy" type="button">${escapeHtml(t('share.copy'))}</button>
            <a class="button share-sheet__open" href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="margin-top:8px;">${escapeHtml(t('share.openInBrowser'))}</a>
            <button class="button sheet-close share-sheet__close" type="button" style="margin-top:8px;">${escapeHtml(t('common.cancel'))}</button>
          </div>
        </div>
      </div>
    </div>
  `
}

/**
 * The desktop/no-share-API path: QR code, the URL in the clear, copy, open.
 *
 * Why the sheet markup looks the way it does — this used to cut the QR code in half.
 *
 * A `.sheet-modal` is not a box that grows with its content. framework7-bundle.css:6648
 * gives it `height: var(--f7-sheet-height)` with `overflow: hidden`, and :root sets that
 * variable to a flat `260px` (framework7-bundle.css:6615). So the sheet was exactly 260px
 * tall no matter what we put in it — and a 260px QR code plus its white card, the hint,
 * the URL and two buttons is roughly 550px. Everything past the first 260 pixels was
 * simply clipped, which is what "the QR code is cut off at the bottom" was.
 *
 * The fix is the structure F7 itself uses for sheets that size to their content:
 *
 *   1. `height: auto` inline on the `.sheet-modal`. It is a single class selector, so an
 *      inline style overrides it, and the sheet is free to be as tall as its content.
 *   2. Keep the `.sheet-modal-inner` wrapper. It is `height: 100%` (…:6682), which against
 *      an auto-height parent resolves to auto, so it hugs the content rather than fighting
 *      it — and F7's swipe-to-close measures the element live, so auto height is fine.
 *   3. Put the content in a `.page-content`, exactly like F7's own color picker sheet does
 *      (components/color-picker/color-picker-class.js:487-493). `.page-content` is
 *      `overflow: auto` (…:378) and its `padding-bottom` already carries
 *      `var(--f7-safe-area-bottom)` (…:386), which :root resolves to
 *      `env(safe-area-inset-bottom)` (…:28). Two things fall out of that for free: the
 *      last button clears the iPhone home indicator, and a max-height on it turns
 *      "too tall for the screen" into scrolling instead of clipping — which is what a
 *      phone in landscape needs. F7's swipe handler explicitly checks for a scrollable
 *      `.page-content` under the finger (components/sheet/sheet-class.js:163,183-187), so
 *      scrolling the content and swiping the sheet away don't fight each other.
 *
 * `--f7-sheet-height` is deliberately left alone: it is a global, and other sheets in the
 * app are entitled to the default.
 */
export async function openShareFallbackSheet({ url }, t) {
  let qrDataUrl = ''
  try {
    qrDataUrl = await buildQrDataUrl(url)
  } catch {
    // A missing QR code is survivable — the URL and the copy button still are there.
    qrDataUrl = ''
  }

  const sheet = f7.sheet.create({
    content: buildSheetHtml({ url, qrDataUrl }, t),
    backdrop: true,
    closeByBackdropClick: true,
    swipeToClose: true,
    on: {
      opened(instance) {
        instance.el?.querySelector('.share-sheet__copy')?.addEventListener('click', () => {
          copyLink(url, t)
        })
        // Opening the link in a browser makes the sheet pointless — close behind it.
        instance.el?.querySelector('.share-sheet__open')?.addEventListener('click', () => {
          instance.close()
        })
        // `.sheet-close` alone would do it via F7's delegated handler, but a mouse has no
        // swipe and the backdrop is not an obvious target — so the button gets a real
        // listener too, and doesn't depend on the delegation being wired up.
        instance.el?.querySelector('.share-sheet__close')?.addEventListener('click', () => {
          instance.close()
        })
      },
      // The sheet is built per share, so it must not pile up in the DOM.
      closed(instance) {
        instance.destroy()
      },
    },
  })

  sheet.open()

  return sheet
}

/**
 * Share `article`, falling back to the QR/copy sheet when the platform can't.
 *
 * `t` is the translation function, passed in the same way src/utils/addMenu.js takes
 * it — these utils stay out of the i18n singleton so the call site owns the locale.
 *
 * Returns 'shared' | 'cancelled' | 'fallback' | 'noop', mostly so this is testable.
 */
export async function shareArticle(article, t) {
  const url = article?.url
  if (!url) return 'noop'

  const title = article?.title || ''

  // Ask before trying. canShare() is the supported way to know whether the platform
  // can share at all (native always says yes; the web shim says no when there is no
  // navigator.share), and it means we don't have to guess from a thrown error.
  let canShare = false
  try {
    const result = await Share.canShare()
    canShare = Boolean(result?.value)
  } catch {
    canShare = false
  }

  if (canShare) {
    try {
      await Share.share({ title, url, dialogTitle: title })
      return 'shared'
    } catch (error) {
      // The user closed the share sheet on purpose. Respect that and stop here.
      if (isUserCancel(error)) return 'cancelled'
      // Anything else means the share didn't happen and wasn't refused — fall through.
    }
  }

  await openShareFallbackSheet({ url, title }, t)
  return 'fallback'
}
