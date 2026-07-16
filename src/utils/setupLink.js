/**
 * Setup links: the AI configuration travels from a big screen to the phone without
 * anyone typing a 60-character API key.
 *
 * The web form (docs/setup-ai.html, quellfeed.de/setup-ai) builds a QR code containing
 *
 *   de.quellfeed://setup#<base64url JSON>
 *
 * — the app scheme directly, so the phone's camera hands the payload straight to the
 * app with no browser in between. The payload sits in the FRAGMENT so that even the
 * https spelling (accepted below as a fallback) could never leak the key into a server
 * access log: browsers do not transmit fragments.
 *
 * The app NEVER applies a setup link silently. Any website or QR code can fire a deep
 * link; without a confirmation, one crafted QR could quietly repoint the AI base URL at
 * an attacker's server, which would then receive every summarized article. App.vue shows
 * what would be imported (key masked) and asks first.
 */
import { AI_PROVIDERS, DEFAULT_AI_SETTINGS } from './ai.js'

export const SETUP_LINK_VERSION = 1

const KNOWN_PROVIDERS = AI_PROVIDERS.map(p => p.id)

/** base64url — the URL-safe alphabet, no padding. Unicode-safe via UTF-8 bytes. */
export function encodeSetupPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeFragment(fragment) {
  const base64 = fragment.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

/**
 * Extracts and validates the AI settings carried by a setup link.
 *
 * Accepts both spellings of the link — the app scheme it actually receives today, and
 * the https form in case App Links get verified later:
 *   de.quellfeed://setup#<payload>
 *   https://quellfeed.de/setup-ai#<payload>   (also /setup, with or without .html)
 *
 * @returns {{ai: {provider, baseUrl, apiKey, model}}|null} a patch for
 *   store.setAiSettings, or null when the URL is not a setup link at all
 * @throws {Error} `invalid_setup_link` when it IS a setup link but the payload is
 *   damaged, of an unknown version, or fails validation — the caller should tell the
 *   user instead of ignoring it silently
 */
export function parseSetupLink(url) {
  const match = String(url || '').match(
    /^(?:de\.quellfeed:\/\/setup|https:\/\/quellfeed\.de\/setup(?:-ai)?(?:\.html)?\/?)#(.+)$/i
  )
  if (!match) return null

  let payload
  try {
    payload = decodeFragment(match[1])
  } catch {
    throw new Error('invalid_setup_link')
  }

  if (!payload || payload.v !== SETUP_LINK_VERSION || typeof payload.ai !== 'object' || !payload.ai) {
    throw new Error('invalid_setup_link')
  }

  const raw = payload.ai
  const provider = String(raw.provider || '').trim()
  const baseUrl = String(raw.baseUrl || '').trim()
  const apiKey = String(raw.apiKey || '').trim()
  const model = String(raw.model || '').trim()

  if (!KNOWN_PROVIDERS.includes(provider)) throw new Error('invalid_setup_link')
  if (!apiKey) throw new Error('invalid_setup_link')
  // These strings end up inside a Framework7 dialog, and F7 dialogs render HTML — so the
  // charsets are restricted to what the values legitimately need, and the dialog escapes
  // them again on top (defence in depth, not either-or).
  if (!/^[\w.\/:@-]*$/.test(model) || model.length > 120) throw new Error('invalid_setup_link')
  // A preset provider carries its own base URL; only `custom` needs one, and it must be
  // something a fetch can actually talk to.
  if (provider === 'custom' && !/^https?:\/\/[^\s"'<>\\]+$/i.test(baseUrl)) {
    throw new Error('invalid_setup_link')
  }

  // Only the four known fields survive — nothing else a payload might smuggle along.
  return {
    ai: {
      provider,
      baseUrl: provider === 'custom' ? baseUrl : '',
      apiKey,
      model: model || DEFAULT_AI_SETTINGS.model,
    },
  }
}

/**
 * What the confirmation dialog shows. The key is masked down to its last four
 * characters — enough to recognise, useless to steal from a screenshot. A key of four
 * characters or fewer is shown whole: it is no real secret, and "ends in …" with
 * nothing after the dots reads like a rendering bug. Everything is HTML-escaped here
 * because Framework7 dialogs render their text as HTML.
 */
export function describeSetupConfig(ai) {
  const provider = AI_PROVIDERS.find(p => p.id === ai.provider)
  const key = ai.apiKey || ''
  return {
    provider: escapeHtml(provider?.label || ai.provider),
    // For `custom` this is the whole point of the dialog: the user must SEE where their
    // article texts would be sent before agreeing.
    baseUrl: escapeHtml(ai.baseUrl || provider?.baseUrl || ''),
    model: escapeHtml(ai.model),
    keyEnding: `…${escapeHtml(key.slice(-4))}`,
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
