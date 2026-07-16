import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Receives links shared into the app from the platform share sheet.
 *
 * The native halves present the SAME plugin API on both platforms, so nothing below
 * branches beyond isShareTargetSupported():
 *
 *  - Android: `android/…/de/quellfeed/ShareIntentPlugin.java` — written by hand because
 *    Capacitor's BridgeActivity never calls `setIntent()` on a new intent, so any plugin
 *    that reads the activity's intent keeps seeing the original launch intent and
 *    concludes nothing was shared. The plugin repairs that, and CONSUMES the intent when
 *    it hands the text over, so a later resume cannot re-save the same link.
 *
 *  - iOS: `ios/App/App/ShareIntentPlugin.swift` plus the QuellShare share extension
 *    (`ios/App/QuellShare`), which queues article URLs into an App Group and opens the
 *    app for feed-looking links — same consume-on-read contract, same event name.
 */
const ShareIntent = registerPlugin('ShareIntent')

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i

// The paths a feed actually lives at. `/blog/feed`, `/rss`, `/atom.xml`, `/index.xml`.
const FEED_PATH = /(^|\/)(feed|feeds|rss|atom)$/i
const FEED_FILE = /\.(xml|rss|atom)$/i

/**
 * What a browser puts in a `text/plain` share is rarely a bare URL — Chrome sends
 * "Page title https://example.com/article", other apps append a footer.
 */
export function extractSharedUrl(text) {
  const match = String(text || '').match(URL_PATTERN)
  if (!match) return null

  // Trailing punctuation from a sentence the URL was embedded in.
  const url = match[0].replace(/[.,;:!?]+$/, '')

  try {
    return new URL(url).href
  } catch {
    return null
  }
}

/**
 * Whether a shared link is meant as a feed to subscribe to rather than an article to save.
 *
 * Deliberately NOT treating a trailing slash as a feed signal: WordPress permalinks
 * (`example.com/2026/07/my-article/`) end in one, and they are articles — the single most
 * common thing anyone shares. A bare domain is the honest "I want the whole site" signal.
 */
export function looksLikeFeedUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    return false
  }

  const path = url.pathname.replace(/\/+$/, '')

  if (!path) return true // bare domain — hand it to feed discovery
  if (FEED_FILE.test(path)) return true
  if (FEED_PATH.test(path)) return true
  if (/[?&]feed=/i.test(url.search)) return true

  return false
}

/** 'feed' → ask the user to subscribe. 'article' → just save it and get out of the way. */
export function classifySharedUrl(url) {
  return looksLikeFeedUrl(url) ? 'feed' : 'article'
}

export function isShareTargetSupported() {
  // Both native platforms ship a ShareIntent plugin with the same API; the web build
  // has no share sheet to be a target of.
  return ['android', 'ios'].includes(Capacitor.getPlatform())
}

/**
 * Calls `onShare(url, kind)` for every link shared into the app — both when the app is
 * already running and when the share started it cold.
 *
 * Since ShareActivity took over ACTION_SEND, only FEED-looking links still arrive this
 * way (forwarded, because subscribing needs a screen). Articles travel through the
 * pending queue below instead — the app never even comes to the front for them.
 *
 * @param {(url: string, kind: 'feed'|'article') => Promise<void>} onShare
 * @returns {Promise<() => void>} removes the listener again
 */
export async function listenForSharedLinks(onShare) {
  if (!isShareTargetSupported()) return () => {}

  async function handle() {
    let text
    try {
      ;({ text } = await ShareIntent.consume())
    } catch {
      return // no share waiting
    }

    const url = extractSharedUrl(text)
    if (url) await onShare(url, classifySharedUrl(url))
  }

  // A share can start the app cold, in which case the intent is already waiting.
  await handle()

  const listener = await ShareIntent.addListener('shareReceived', handle)
  return () => listener.remove()
}

/**
 * The articles ShareActivity queued while the app was away. Reading them clears the
 * queue, so every URL comes out exactly once — the caller MUST import what it gets.
 *
 * @returns {Promise<string[]>}
 */
export async function consumePendingShares() {
  if (!isShareTargetSupported()) return []

  try {
    const { urls } = await ShareIntent.consumePending()
    return Array.isArray(urls) ? urls.filter(u => typeof u === 'string' && u) : []
  } catch {
    return []
  }
}
