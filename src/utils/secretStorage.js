import { SecureStorage } from '@aparajita/capacitor-secure-storage'

/**
 * Passwords and API keys, kept apart from the ordinary settings.
 *
 * The settings blob is a plain Preferences entry — unencrypted, and with
 * `allowBackup` part of the user's Google cloud backup. The secrets now live in the
 * platform's secure store instead: Android Keystore (AES-GCM, key never leaves the
 * device), iOS Keychain. The settings blob only ever holds '' in their place.
 *
 * Android: the encrypted values sit in the SharedPreferences file
 * WSSecureStorageSharedPreferences, which is excluded from backup (res/xml/backup_rules.xml):
 * restored onto a new phone it would be undecryptable anyway, because the Keystore key
 * does not travel with it.
 *
 * In the browser dev build the plugin falls back to localStorage — fine for development,
 * and the dev build is not a target platform.
 */
export const SECRET_FIELDS = [
  ['ai', 'apiKey'],
  ['webdav', 'password'],
  ['karakeep', 'apiKey'],
  ['linkwarden', 'apiKey'],
]

const KEY_PREFIX = 'quell.secret.'

function keyOf(section, field) {
  return `${KEY_PREFIX}${section}.${field}`
}

/**
 * Returns `{ settings, secrets }`: a copy of the settings with every secret blanked, and
 * the secrets as a flat `section.field -> value` map.
 */
export function splitSecrets(settings) {
  const copy = { ...settings }
  const secrets = {}

  for (const [section, field] of SECRET_FIELDS) {
    if (!copy[section]) continue
    copy[section] = { ...copy[section] }
    secrets[`${section}.${field}`] = String(copy[section][field] || '')
    copy[section][field] = ''
  }

  return { settings: copy, secrets }
}

/** Does a stored settings blob still carry a secret in the clear (written before this)? */
export function hasPlainSecrets(saved) {
  return SECRET_FIELDS.some(([section, field]) => Boolean(saved?.[section]?.[field]))
}

// What the secure store holds right now, so a settings save that changed no secret
// (most of them: theme, font, a sync timestamp) does not touch the Keystore at all.
const known = new Map()

export async function loadSecrets() {
  const secrets = {}
  await Promise.all(
    SECRET_FIELDS.map(async ([section, field]) => {
      const name = `${section}.${field}`
      try {
        const value = await SecureStorage.getItem(keyOf(section, field))
        secrets[name] = value || ''
      } catch (err) {
        // Unreadable (e.g. a Keystore reset): the user has to enter it again, the app runs on.
        console.warn(`[secrets] could not read ${name}:`, err?.code || err?.name || 'error')
        secrets[name] = ''
      }
      known.set(name, secrets[name])
    }),
  )
  return secrets
}

export async function saveSecrets(secrets) {
  await Promise.all(
    Object.entries(secrets).map(async ([name, value]) => {
      if (known.get(name) === value) return
      const [section, field] = name.split('.')
      if (value) await SecureStorage.setItem(keyOf(section, field), value)
      else await SecureStorage.removeItem(keyOf(section, field))
      known.set(name, value)
    }),
  )
}

/** Test hook. */
export function _resetSecretCache() {
  known.clear()
}
