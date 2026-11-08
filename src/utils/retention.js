/**
 * How long a feed article stays on the device when nobody saved it.
 *
 * There was no pruning at all: every item every feed ever delivered stayed forever, and
 * the whole list was rewritten on every tap. Read-later is the place for keeping things;
 * the feed is a stream.
 *
 * THE INVARIANT (see archiveArticle in the store): an article with `isSaved` or
 * `isArchived` is NEVER pruned, and neither is a link (feedId null — those are saved by
 * definition). Pruning writes no tombstone: it is housekeeping, not a deletion, and
 * another device is free to keep its own copy for its own retention window.
 */
export const ARTICLE_RETENTION_DAYS = 60
const DAY_MS = 24 * 60 * 60 * 1000

export function retentionCutoff(now = Date.now(), days = ARTICLE_RETENTION_DAYS) {
  return now - days * DAY_MS
}

function timeOf(value) {
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Does this article survive pruning at `cutoffMs`?
 *
 * `currentUrlsByFeed` (feedId -> Set of the URLs that feed delivered on its last
 * successful refresh) protects what the feed still carries: pruning such an item would
 * only bring it back on the next refresh as "new and unread". A feed with no recorded
 * set (not refreshed since this was introduced, or offline) keeps all its articles.
 */
export function isKeptArticle(article, cutoffMs, currentUrlsByFeed = null) {
  if (!article) return false
  if (article.isSaved || article.isArchived || !article.feedId) return true
  const current = currentUrlsByFeed?.get?.(article.feedId)
  if (!current || current.has(article.url)) return true
  // The newer of "published" and "last touched": an old article someone just marked
  // unread is still in use.
  return Math.max(timeOf(article.publishedAt), timeOf(article.updatedAt)) >= cutoffMs
}

export function pruneArticles(articles, cutoffMs, currentUrlsByFeed = null) {
  const kept = articles.filter(a => isKeptArticle(a, cutoffMs, currentUrlsByFeed))
  return { articles: kept, removed: articles.length - kept.length }
}
