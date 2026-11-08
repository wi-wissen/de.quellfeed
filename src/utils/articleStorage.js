import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { storageGet, storageRemove } from './storage.js'

/**
 * Where the articles live on the device.
 *
 * They used to be ONE `@capacitor/preferences` entry — on Android a SharedPreferences
 * XML file, which is built for a handful of small settings: it is parsed into memory as
 * a whole and rewritten as a whole on every change. With the offline HTML of every
 * saved article inside (megabytes each), marking one article as read rewrote all of it.
 *
 * Now:
 *   quell/articles.json        the article list WITHOUT `cachedHtml` (small)
 *   quell/html/<id>.html       one file per offline copy, written only when it changed
 *
 * The in-memory model is unchanged — articles still carry `cachedHtml` — so nothing
 * outside this module had to learn about files.
 *
 * Android: Directory.Data is the app's private files dir. The HTML folder is excluded
 * from cloud backup (res/xml/backup_rules.xml): it is re-fetchable, and Android drops the
 * WHOLE backup once an app goes over 25 MB.
 */
const DIR = Directory.Data
const ROOT = 'quell'
const META_PATH = `${ROOT}/articles.json`
const META_TMP_PATH = `${ROOT}/articles.json.tmp`
const HTML_DIR = `${ROOT}/html`
const LEGACY_PREFERENCES_KEY = 'quell:articles'
const FORMAT_VERSION = 1

// id -> fingerprint of the HTML currently on disk, so a save only touches changed files.
const onDisk = new Map()

function htmlPath(id) {
  // Ids are crypto.randomUUID() — but they also arrive through sync and import, and a
  // path is no place to trust one.
  return `${HTML_DIR}/${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.html`
}

/** Cheap change detection — FNV-1a over the string, plus its length. */
export function fingerprint(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

async function readText(path) {
  try {
    const { data } = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
    return typeof data === 'string' ? data : null
  } catch {
    return null
  }
}

async function writeText(path, data) {
  await Filesystem.writeFile({ path, data, directory: DIR, encoding: Encoding.UTF8, recursive: true })
}

async function deleteQuietly(path) {
  try {
    await Filesystem.deleteFile({ path, directory: DIR })
  } catch {
    // Already gone — which is what we wanted.
  }
}

/**
 * Loads all articles, `cachedHtml` included. On first start after the update the old
 * Preferences entry is moved over and removed.
 */
export async function loadArticles() {
  const raw = (await readText(META_PATH)) ?? (await readText(META_TMP_PATH))

  if (raw == null) {
    const legacy = await storageGet(LEGACY_PREFERENCES_KEY)
    if (!Array.isArray(legacy)) return []

    onDisk.clear()
    await writeAll(legacy)
    // Only after the files are safely written — a crash in between keeps the old copy.
    await storageRemove(LEGACY_PREFERENCES_KEY)
    return legacy
  }

  let meta
  try {
    meta = JSON.parse(raw)
  } catch {
    console.error('[articleStorage] articles.json is unreadable')
    return []
  }

  const articles = Array.isArray(meta?.articles) ? meta.articles : []
  const withHtml = new Set(Array.isArray(meta?.html) ? meta.html : [])

  onDisk.clear()
  await Promise.all(
    articles.map(async article => {
      if (!withHtml.has(article.id)) {
        article.cachedHtml = article.cachedHtml ?? null
        return
      }
      const html = await readText(htmlPath(article.id))
      article.cachedHtml = html
      if (html != null) onDisk.set(article.id, fingerprint(html))
    }),
  )

  return articles
}

async function writeAll(articles) {
  const html = []
  const liveIds = new Set()

  for (const article of articles) {
    if (!article?.id) continue
    liveIds.add(article.id)

    if (typeof article.cachedHtml === 'string' && article.cachedHtml) {
      html.push(article.id)
      const print = fingerprint(article.cachedHtml)
      if (onDisk.get(article.id) !== print) {
        await writeText(htmlPath(article.id), article.cachedHtml)
        onDisk.set(article.id, print)
      }
    } else if (onDisk.has(article.id)) {
      await deleteQuietly(htmlPath(article.id))
      onDisk.delete(article.id)
    }
  }

  for (const id of [...onDisk.keys()]) {
    if (!liveIds.has(id)) {
      await deleteQuietly(htmlPath(id))
      onDisk.delete(id)
    }
  }

  const list = articles.map(({ cachedHtml, ...rest }) => rest) // eslint-disable-line no-unused-vars
  const body = JSON.stringify({ version: FORMAT_VERSION, articles: list, html })

  // Write-then-rename: a crash mid-write leaves the previous list intact instead of a
  // truncated file that would read as "no articles". Whether `rename` overwrites an
  // existing target differs between platforms, so the old file goes first — and
  // loadArticles() falls back to the .tmp for the moment in between.
  await writeText(META_TMP_PATH, body)
  await deleteQuietly(META_PATH)
  await Filesystem.rename({ from: META_TMP_PATH, to: META_PATH, directory: DIR, toDirectory: DIR })
}

// Saves run strictly one after another and collapse: ten taps in a row cause one or two
// writes of the newest state, never ten overlapping writes to the same file.
let chain = Promise.resolve()
let pending = null

export function saveArticles(articles) {
  pending = articles
  const run = chain.then(async () => {
    if (!pending) return
    const snapshot = pending
    pending = null
    await writeAll(snapshot)
  })
  chain = run.catch(err => console.error('[articleStorage] save failed:', err?.message || err))
  return run
}

/** Test hook: forget what is on disk. */
export function _resetArticleStorage() {
  onDisk.clear()
  chain = Promise.resolve()
  pending = null
}
