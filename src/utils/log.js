/**
 * Chatty diagnostics — which URL was fetched, which status came back — belong in the
 * dev build only. A release build writes them to logcat, where any app with log access
 * on an old or rooted device can read the user's reading list. Warnings and errors
 * stay on `console.warn`/`console.error`: those are what a bug report needs.
 */
export function debug(...args) {
  if (import.meta.env.DEV) console.info(...args)
}
