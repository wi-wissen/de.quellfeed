import { describe, it, expect } from 'vitest'
import {
  isKeptArticle,
  pruneArticles,
  retentionCutoff,
  ARTICLE_RETENTION_DAYS,
} from '../src/utils/retention.js'
import { mergeSyncState } from '../src/utils/sync.js'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const daysAgo = d => new Date(NOW - d * 864e5).toISOString()
const cutoff = retentionCutoff(NOW)
// f1 was refreshed and carries none of the test articles any more.
const refreshed = new Map([['f1', new Set()]])

const feedArticle = (url, age, extra = {}) => ({
  id: url,
  feedId: 'f1',
  url,
  title: url,
  publishedAt: daysAgo(age),
  updatedAt: daysAgo(age),
  ...extra,
})

describe('retention', () => {
  it('drops unsaved feed articles past the window', () => {
    const old = feedArticle('https://x.example/old', ARTICLE_RETENTION_DAYS + 1)
    const young = feedArticle('https://x.example/young', 3)
    expect(isKeptArticle(old, cutoff, refreshed)).toBe(false)
    expect(isKeptArticle(young, cutoff, refreshed)).toBe(true)
  })

  it('never drops saved, archived or link articles, however old', () => {
    for (const extra of [{ isSaved: true }, { isArchived: true }, { feedId: null }]) {
      expect(isKeptArticle(feedArticle('https://x.example/a', 999, extra), cutoff)).toBe(true)
    }
  })

  it('keeps an old article the feed still carries, so it cannot come back as new', () => {
    const old = feedArticle('https://x.example/old', 400)
    const current = new Map([['f1', new Set([old.url])]])
    expect(isKeptArticle(old, cutoff, current)).toBe(true)

    const left = new Map([['f1', new Set(['https://x.example/other'])]])
    expect(isKeptArticle(old, cutoff, left)).toBe(false)
  })

  it('keeps everything of a feed it knows nothing about yet', () => {
    expect(isKeptArticle(feedArticle('https://x.example/old', 400), cutoff)).toBe(true)
  })

  it('counts a recent touch as use', () => {
    const touched = feedArticle('https://x.example/t', 400, { updatedAt: daysAgo(1) })
    expect(isKeptArticle(touched, cutoff, refreshed)).toBe(true)
  })

  it('reports how many went', () => {
    const { articles, removed } = pruneArticles(
      [feedArticle('https://x.example/1', 100), feedArticle('https://x.example/2', 1)],
      cutoff,
      refreshed,
    )
    expect(removed).toBe(1)
    expect(articles.map(a => a.url)).toEqual(['https://x.example/2'])
  })

  it('also shrinks the shared WebDAV file, so a pruned article does not come back', () => {
    const feeds = [{ id: 'f1', url: 'https://x.example/feed', title: 'X', updatedAt: daysAgo(500) }]
    const remote = {
      version: 1,
      feeds: [{ url: 'https://x.example/feed', title: 'X', updatedAt: daysAgo(500) }],
      articles: [
        {
          url: 'https://x.example/old',
          feedUrl: 'https://x.example/feed',
          title: 'old',
          publishedAt: daysAgo(200),
          updatedAt: daysAgo(200),
        },
      ],
      tombstones: { feeds: {}, articles: {} },
    }

    const merged = mergeSyncState({ feeds, articles: [], tombstones: null }, remote, {
      now: NOW,
      keepArticle: a => isKeptArticle(a, cutoff, refreshed),
    })

    expect(merged.articles).toHaveLength(0)
    expect(merged.remoteChanged).toBe(true)
  })
})
