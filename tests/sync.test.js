import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SYNC_VERSION,
  TOMBSTONE_MAX_AGE_MS,
  DEFAULT_WEBDAV_SETTINGS,
  buildSyncPayload,
  parseSyncPayload,
  serializeSyncPayload,
  mergeSyncState,
  createEmptyTombstones,
  addTombstone,
  pruneTombstones,
  isWebdavConfigured,
  testWebdavConnection,
  syncWithWebdav,
} from '../src/utils/sync.js'
import { getFile, putFile, testConnection } from '../src/utils/webdav.js'

vi.mock('../src/utils/webdav.js', () => ({
  getFile: vi.fn(),
  putFile: vi.fn(),
  testConnection: vi.fn(),
  isWebdavConfigured: vi.fn(config => Boolean(config?.baseUrl && config?.username && config?.password)),
}))

// A fixed clock and a counting id factory — the merge is deterministic, so the tests are.
const NOW = '2026-07-12T12:00:00.000Z'

function ids() {
  let n = 0
  return () => `id-${++n}`
}

function merge(local, remote, options = {}) {
  return mergeSyncState(local, remote, { now: NOW, newId: ids(), ...options })
}

function feed(overrides = {}) {
  return {
    id: 'local-feed-1',
    url: 'https://example.com/feed.xml',
    title: 'Example',
    favicon: 'https://example.com/favicon.ico',
    lastFetched: '2026-07-01T00:00:00.000Z',
    filterPrompt: '',
    ...overrides,
  }
}

function article(overrides = {}) {
  return {
    id: 'local-article-1',
    feedId: 'local-feed-1',
    source: 'example.com',
    url: 'https://example.com/story-1',
    title: 'Story 1',
    description: 'A story.',
    image: null,
    isRead: false,
    isSaved: false,
    isArchived: false,
    isQuelled: false,
    publishedAt: '2026-07-01T10:00:00.000Z',
    cachedHtml: null,
    ...overrides,
  }
}

/** A remote payload, built from a store-shaped state — the way a second device writes it. */
function remoteOf(state, options = {}) {
  return buildSyncPayload(
    { tombstones: createEmptyTombstones(), ...state },
    { now: NOW, ...options },
  )
}

const EMPTY = { feeds: [], articles: [], tombstones: createEmptyTombstones() }

describe('buildSyncPayload', () => {
  it('writes a versioned envelope with feeds, articles and tombstones', () => {
    const payload = buildSyncPayload({ feeds: [feed()], articles: [article()] }, { now: NOW })

    expect(payload.version).toBe(SYNC_VERSION)
    expect(payload.updatedAt).toBe(NOW)
    expect(payload.feeds).toHaveLength(1)
    expect(payload.articles).toHaveLength(1)
    expect(payload.tombstones).toEqual({ feeds: {}, articles: {} })
  })

  it('never writes cachedHtml into the payload', () => {
    const heavy = article({ cachedHtml: '<p>'.padEnd(5000, 'x') })
    const payload = buildSyncPayload({ feeds: [feed()], articles: [heavy] }, { now: NOW })

    expect(payload.articles[0]).not.toHaveProperty('cachedHtml')
    expect(serializeSyncPayload(payload)).not.toContain('cachedHtml')
    expect(serializeSyncPayload(payload)).not.toContain('xxxx')
  })

  it('drops the local ids and names the feed by url instead', () => {
    const payload = buildSyncPayload({ feeds: [feed()], articles: [article()] }, { now: NOW })

    expect(payload.feeds[0]).not.toHaveProperty('id')
    expect(payload.articles[0]).not.toHaveProperty('id')
    expect(payload.articles[0]).not.toHaveProperty('feedId')
    expect(payload.articles[0].feedUrl).toBe('https://example.com/feed.xml')
  })

  it('keeps a link article (no feed) as feedUrl null', () => {
    const link = article({ feedId: null, url: 'https://example.com/link', isSaved: true })
    const payload = buildSyncPayload({ feeds: [], articles: [link] }, { now: NOW })

    expect(payload.articles[0].feedUrl).toBeNull()
  })

  it('skips items without a usable url', () => {
    const payload = buildSyncPayload({
      feeds: [feed(), feed({ id: 'x', url: 'not-a-url' })],
      articles: [article(), article({ id: 'y', url: '' })],
    }, { now: NOW })

    expect(payload.feeds).toHaveLength(1)
    expect(payload.articles).toHaveLength(1)
  })

  it('prunes expired tombstones on the way out', () => {
    const old = new Date(Date.parse(NOW) - TOMBSTONE_MAX_AGE_MS - 1000).toISOString()
    const payload = buildSyncPayload({
      feeds: [],
      articles: [],
      tombstones: {
        articles: { 'https://example.com/old': old, 'https://example.com/fresh': NOW },
        feeds: {},
      },
    }, { now: NOW })

    expect(payload.tombstones.articles).toEqual({ 'https://example.com/fresh': NOW })
  })
})

describe('parseSyncPayload', () => {
  it('parses a string body', () => {
    const json = serializeSyncPayload(buildSyncPayload({ feeds: [feed()], articles: [] }, { now: NOW }))
    const parsed = parseSyncPayload(json)

    expect(parsed.version).toBe(SYNC_VERSION)
    expect(parsed.feeds[0].url).toBe('https://example.com/feed.xml')
  })

  it('accepts an object body (CapacitorHttp parses application/json for us)', () => {
    const parsed = parseSyncPayload(buildSyncPayload({ feeds: [feed()] }, { now: NOW }))

    expect(parsed.feeds).toHaveLength(1)
  })

  it('tolerates missing fields', () => {
    const parsed = parseSyncPayload({ version: 1 })

    expect(parsed.feeds).toEqual([])
    expect(parsed.articles).toEqual([])
    expect(parsed.tombstones).toEqual({ feeds: {}, articles: {} })
  })

  it('ignores unknown fields, so a newer writer does not break us', () => {
    const parsed = parseSyncPayload({
      version: 99,
      somethingNew: { a: 1 },
      feeds: [{ url: 'https://example.com/feed.xml', title: 'E', colour: 'red' }],
      articles: [{ url: 'https://example.com/a', unknownFlag: true }],
    })

    expect(parsed.version).toBe(99)
    expect(parsed.feeds[0].title).toBe('E')
    expect(parsed.articles[0].url).toBe('https://example.com/a')
  })

  it('drops single unusable items instead of failing the whole file', () => {
    const parsed = parseSyncPayload({
      version: 1,
      feeds: [{ url: 'https://example.com/feed.xml' }, { url: 'nonsense' }, null, 42],
      articles: [{ url: 'https://example.com/a' }, {}, 'oops'],
    })

    expect(parsed.feeds).toHaveLength(1)
    expect(parsed.articles).toHaveLength(1)
  })

  it.each([
    ['not json at all', 'not json at all'],
    ['an empty string', ''],
    ['a bookmark file', '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://a.b">x</A></DL>'],
    ['a foreign json object', '{"bookmarks":[]}'],
    ['a json array', '[]'],
    ['a json string', '"hello"'],
    ['null', null],
    ['a payload without a version', { feeds: [], articles: [] }],
    ['a payload with a nonsense version', { version: 'one' }],
    ['a payload whose feeds are not a list', { version: 1, feeds: {} }],
    ['a payload whose articles are not a list', { version: 1, articles: 'none' }],
  ])('throws invalid_payload on %s', (_label, input) => {
    expect(() => parseSyncPayload(input)).toThrow('invalid_payload')
  })
})

describe('mergeSyncState — nothing gets lost', () => {
  it('keeps every local item when the remote is empty', () => {
    const local = { feeds: [feed()], articles: [article()], tombstones: createEmptyTombstones() }

    const merged = merge(local, null)

    expect(merged.feeds).toHaveLength(1)
    expect(merged.articles).toHaveLength(1)
    expect(merged.articles[0].id).toBe('local-article-1')
    expect(merged.changed).toBe(false)
    expect(merged.remoteChanged).toBe(true)
    expect(merged.pushed).toBe(2)
    expect(merged.pulled).toBe(0)
  })

  it('brings every remote item in when the local state is empty', () => {
    const remote = remoteOf({ feeds: [feed()], articles: [article()] })

    const merged = merge(EMPTY, remote)

    expect(merged.feeds).toHaveLength(1)
    expect(merged.articles).toHaveLength(1)
    expect(merged.changed).toBe(true)
    expect(merged.remoteChanged).toBe(false)
    expect(merged.pulled).toBe(2)
    expect(merged.pushed).toBe(0)
  })

  it('gives a remote item a local id and wires it to the local feed', () => {
    const remote = remoteOf({ feeds: [feed()], articles: [article()] })

    const merged = merge(EMPTY, remote)

    expect(merged.feeds[0].id).toBe('id-1')
    expect(merged.articles[0].id).toBe('id-2')
    expect(merged.articles[0].feedId).toBe('id-1')
    expect(merged.articles[0].cachedHtml).toBeNull()
  })

  it('adopts an existing local feed rather than adding a second one for the same url', () => {
    const local = { feeds: [feed({ id: 'mine' })], articles: [], tombstones: createEmptyTombstones() }
    const remote = remoteOf({
      feeds: [feed({ id: 'theirs' })],
      articles: [article({ id: 'theirs-a', feedId: 'theirs' })],
    })

    const merged = merge(local, remote)

    expect(merged.feeds).toHaveLength(1)
    expect(merged.feeds[0].id).toBe('mine')
    expect(merged.articles[0].feedId).toBe('mine')
  })
})

describe('mergeSyncState — identity is the url, not the id', () => {
  it('does not duplicate an article that both devices have under different ids', () => {
    const local = {
      feeds: [feed({ id: 'feed-a' })],
      articles: [article({ id: 'article-a', feedId: 'feed-a' })],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({
      feeds: [feed({ id: 'feed-b' })],
      articles: [article({ id: 'article-b', feedId: 'feed-b' })],
    })

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(1)
    expect(merged.feeds).toHaveLength(1)
    // The local id survives — the other device's UUID never enters this device.
    expect(merged.articles[0].id).toBe('article-a')
    expect(merged.feeds[0].id).toBe('feed-a')
    expect(merged.changed).toBe(false)
    expect(merged.remoteChanged).toBe(false)
  })

  it('keeps the local cachedHtml and never takes one from the remote', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ cachedHtml: '<p>cached locally</p>' })],
      tombstones: createEmptyTombstones(),
    }
    // A malicious or buggy writer that puts cachedHtml into the file must not get it in.
    const remote = remoteOf({ feeds: [feed()], articles: [article()] })
    remote.articles[0].cachedHtml = '<p>from the server</p>'

    const merged = merge(local, remote)

    expect(merged.articles[0].cachedHtml).toBe('<p>cached locally</p>')
  })

  it('never carries cachedHtml back out into the payload', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ cachedHtml: '<p>cached</p>' })],
      tombstones: createEmptyTombstones(),
    }

    const merged = merge(local, null)
    const payload = buildSyncPayload(merged, { now: NOW })

    expect(serializeSyncPayload(payload)).not.toContain('cached')
  })
})

describe('mergeSyncState — deletions stay deleted', () => {
  const DELETED_AT = '2026-07-05T00:00:00.000Z'

  it('does not resurrect an article that A deleted and B still has', () => {
    const local = {
      feeds: [feed()],
      articles: [],
      tombstones: { feeds: {}, articles: { 'https://example.com/story-1': DELETED_AT } },
    }
    const remote = remoteOf({ feeds: [feed()], articles: [article()] })

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(0)
    expect(merged.tombstones.articles['https://example.com/story-1']).toBe(DELETED_AT)
    // …and the deletion is pushed to the other side.
    expect(merged.remoteChanged).toBe(true)
  })

  it('deletes on B what A deleted, when B is the one merging', () => {
    const local = {
      feeds: [feed()],
      articles: [article()],
      tombstones: createEmptyTombstones(),
    }
    const remote = {
      ...remoteOf({ feeds: [feed()], articles: [] }),
      tombstones: { feeds: {}, articles: { 'https://example.com/story-1': DELETED_AT } },
    }

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(0)
    expect(merged.changed).toBe(true)
    expect(merged.pulled).toBe(1)
  })

  it('lets a re-add that happened AFTER the deletion win', () => {
    const readdedAt = '2026-07-08T00:00:00.000Z'
    const local = {
      feeds: [feed()],
      articles: [],
      tombstones: { feeds: {}, articles: { 'https://example.com/story-1': DELETED_AT } },
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [article({ updatedAt: readdedAt })],
    })

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(1)
    // The grave is emptied, or the next merge on the other device would bury it again.
    expect(merged.tombstones.articles).toEqual({})
  })

  it('falls back to publishedAt when the store never stamped an updatedAt', () => {
    // A link added by hand right now: publishedAt is "now", which is after the deletion.
    const local = {
      feeds: [],
      articles: [],
      tombstones: { feeds: {}, articles: { 'https://example.com/link': DELETED_AT } },
    }
    const remote = remoteOf({
      feeds: [],
      articles: [article({
        feedId: null,
        url: 'https://example.com/link',
        isSaved: true,
        publishedAt: '2026-07-09T00:00:00.000Z',
      })],
    })

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(1)
  })

  it('keeps an old feed article deleted even though the feed keeps re-serving it', () => {
    // The re-fetched item carries its original publish date, which is older than the
    // deletion — so it stays in its grave. This is the case that makes the fallback safe.
    const local = {
      feeds: [feed()],
      articles: [],
      tombstones: { feeds: {}, articles: { 'https://example.com/story-1': DELETED_AT } },
    }
    const remote = remoteOf({
      feeds: [feed({ lastFetched: '2026-07-11T00:00:00.000Z' })],
      articles: [article({ publishedAt: '2026-07-01T10:00:00.000Z' })],
    })

    const merged = merge(local, remote)

    expect(merged.articles).toHaveLength(0)
  })

  it('takes a deleted feed\'s articles with it, on both sides', () => {
    const local = {
      feeds: [],
      articles: [],
      tombstones: { feeds: { 'https://example.com/feed.xml': DELETED_AT }, articles: {} },
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [article(), article({ id: 'a2', url: 'https://example.com/story-2' })],
    })

    const merged = merge(local, remote)

    expect(merged.feeds).toHaveLength(0)
    expect(merged.articles).toHaveLength(0)
  })

  it('lets a saved or archived article SURVIVE its feed\'s tombstone, detached into a link', () => {
    // "Archived = keep forever", and a bookmark is a bookmark: unsubscribing the feed
    // (here: on the other device) must not take them to the grave with it.
    const local = {
      feeds: [],
      articles: [],
      tombstones: { feeds: { 'https://example.com/feed.xml': DELETED_AT }, articles: {} },
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [
        article(), // plain: dies with the feed
        article({ id: 'a2', url: 'https://example.com/story-2', isSaved: true, isArchived: true }),
      ],
    })

    const merged = merge(local, remote)

    expect(merged.feeds).toHaveLength(0)
    expect(merged.articles.map(a => a.url)).toEqual(['https://example.com/story-2'])
    expect(merged.articles[0].feedId).toBeNull()
    expect(merged.articles[0].isArchived).toBe(true)
    // …and the file both devices write carries it as a feed-less link.
    expect(buildSyncPayload(merged, { now: NOW }).articles[0].feedUrl).toBeNull()
  })

  it('does not let a feed climb out of its grave just because the other device kept polling it', () => {
    // lastFetched is a machine timestamp and must never count as "the user touched this".
    const local = {
      feeds: [],
      articles: [],
      tombstones: { feeds: { 'https://example.com/feed.xml': DELETED_AT }, articles: {} },
    }
    const remote = remoteOf({ feeds: [feed({ lastFetched: '2026-07-11T23:59:00.000Z' })], articles: [] })

    const merged = merge(local, remote)

    expect(merged.feeds).toHaveLength(0)
  })

  it('keeps the later of two deletions of the same url', () => {
    const local = {
      ...EMPTY,
      tombstones: { feeds: {}, articles: { 'https://example.com/story-1': '2026-07-02T00:00:00.000Z' } },
    }
    const remote = { ...remoteOf({}), tombstones: { feeds: {}, articles: { 'https://example.com/story-1': DELETED_AT } } }

    const merged = merge(local, remote)

    expect(merged.tombstones.articles['https://example.com/story-1']).toBe(DELETED_AT)
  })

  it('forgets tombstones once they expire', () => {
    const expired = new Date(Date.parse(NOW) - TOMBSTONE_MAX_AGE_MS - 1).toISOString()
    const fresh = new Date(Date.parse(NOW) - TOMBSTONE_MAX_AGE_MS + 60_000).toISOString()
    const local = {
      ...EMPTY,
      tombstones: {
        feeds: { 'https://example.com/gone.xml': expired },
        articles: { 'https://example.com/old': expired, 'https://example.com/recent': fresh },
      },
    }

    const merged = merge(local, null)

    expect(merged.tombstones.feeds).toEqual({})
    expect(merged.tombstones.articles).toEqual({ 'https://example.com/recent': fresh })
    expect(merged.changed).toBe(true)
  })
})

describe('mergeSyncState — the conflict rule for isRead / isSaved', () => {
  it('keeps an article read that was read on the other device', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ isRead: false })],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({ feeds: [feed()], articles: [article({ isRead: true })] })

    const merged = merge(local, remote)

    expect(merged.articles[0].isRead).toBe(true)
    expect(merged.changed).toBe(true)
  })

  it('keeps an article saved that was saved on the other device', () => {
    const local = { feeds: [feed()], articles: [article({ isSaved: false })], tombstones: createEmptyTombstones() }
    const remote = remoteOf({ feeds: [feed()], articles: [article({ isSaved: true })] })

    expect(merge(local, remote).articles[0].isSaved).toBe(true)
  })

  it('lets a LATER "mark unread" beat the earlier read — true only wins without evidence', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ isRead: false, updatedAt: '2026-07-10T00:00:00.000Z' })],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [article({ isRead: true, updatedAt: '2026-07-09T00:00:00.000Z' })],
    })

    const merged = merge(local, remote)

    expect(merged.articles[0].isRead).toBe(false)
  })

  it('lets a later un-save beat the earlier save', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ isSaved: true, updatedAt: '2026-07-08T00:00:00.000Z' })],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [article({ isSaved: false, updatedAt: '2026-07-09T00:00:00.000Z' })],
    })

    expect(merge(local, remote).articles[0].isSaved).toBe(false)
  })

  it('never drops a summary the other device paid for', () => {
    const local = { feeds: [feed()], articles: [article()], tombstones: createEmptyTombstones() }
    const remote = remoteOf({ feeds: [feed()], articles: [article({ summary: 'A TL;DR.' })] })

    expect(merge(local, remote).articles[0].summary).toBe('A TL;DR.')
  })

  it('keeps an article archived that was archived on the other device', () => {
    const local = { feeds: [feed()], articles: [article({ isArchived: false })], tombstones: createEmptyTombstones() }
    const remote = remoteOf({ feeds: [feed()], articles: [article({ isArchived: true, isSaved: true })] })

    const merged = merge(local, remote)

    expect(merged.articles[0].isArchived).toBe(true)
    // Archived implies saved — that is what keeps the article offline-readable forever.
    expect(merged.articles[0].isSaved).toBe(true)
  })

  it('lets a later restore beat the earlier archive', () => {
    const local = {
      feeds: [feed()],
      articles: [article({ isArchived: true, isSaved: true, updatedAt: '2026-07-08T00:00:00.000Z' })],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({
      feeds: [feed()],
      articles: [article({ isArchived: false, isSaved: true, updatedAt: '2026-07-09T00:00:00.000Z' })],
    })

    expect(merge(local, remote).articles[0].isArchived).toBe(false)
  })

  it('syncs isQuelled under the same rule', () => {
    const local = { feeds: [feed()], articles: [article({ isQuelled: false })], tombstones: createEmptyTombstones() }
    const remote = remoteOf({ feeds: [feed()], articles: [article({ isQuelled: true })] })

    expect(merge(local, remote).articles[0].isQuelled).toBe(true)
  })

  it('is decided the same way whichever device merges', () => {
    const localA = { feeds: [feed()], articles: [article({ isRead: true, isSaved: false })], tombstones: createEmptyTombstones() }
    const stateB = { feeds: [feed({ id: 'other' })], articles: [article({ id: 'other-a', feedId: 'other', isRead: false, isSaved: true })] }

    const aMerges = merge(localA, remoteOf(stateB))
    const bMerges = merge({ ...stateB, tombstones: createEmptyTombstones() }, remoteOf(localA))

    expect(aMerges.articles[0].isRead).toBe(bMerges.articles[0].isRead)
    expect(aMerges.articles[0].isSaved).toBe(bMerges.articles[0].isSaved)
    expect(aMerges.articles[0].isRead).toBe(true)
    expect(aMerges.articles[0].isSaved).toBe(true)
  })
})

describe('mergeSyncState — algebraic properties', () => {
  const local = {
    feeds: [feed(), feed({ id: 'f2', url: 'https://other.com/rss', title: 'Other' })],
    articles: [
      article({ isRead: true }),
      article({ id: 'a2', url: 'https://example.com/story-2', publishedAt: '2026-07-02T10:00:00.000Z' }),
      article({ id: 'a3', feedId: null, url: 'https://example.com/link', isSaved: true }),
    ],
    tombstones: { feeds: {}, articles: { 'https://example.com/dead': '2026-07-05T00:00:00.000Z' } },
  }
  const remoteState = {
    feeds: [feed({ id: 'r1' }), feed({ id: 'r3', url: 'https://third.com/rss', title: 'Third' })],
    articles: [
      article({ id: 'r-a1', feedId: 'r1', isSaved: true }),
      article({ id: 'r-a4', feedId: 'r3', url: 'https://third.com/story', publishedAt: '2026-07-03T10:00:00.000Z' }),
    ],
  }

  it('is idempotent — merging twice changes nothing the second time', () => {
    const once = merge(local, remoteOf(remoteState))
    const twice = mergeSyncState(once, buildSyncPayload(once, { now: NOW }), { now: NOW, newId: ids() })

    expect(twice.feeds).toEqual(once.feeds)
    expect(twice.articles).toEqual(once.articles)
    expect(twice.tombstones).toEqual(once.tombstones)
    expect(twice.changed).toBe(false)
    expect(twice.remoteChanged).toBe(false)
  })

  it('converges on the same state whichever device merges first', () => {
    const onA = merge(local, remoteOf(remoteState))
    const onB = merge({ ...remoteState, tombstones: createEmptyTombstones() }, remoteOf(local, {
      // The other device's tombstones travel in its payload.
      now: NOW,
    }))

    // Ids are per-device, so compare what the sync file actually carries.
    const fileA = buildSyncPayload(onA, { now: NOW })
    const fileB = buildSyncPayload(onB, { now: NOW })

    expect(fileB.feeds).toEqual(fileA.feeds)
    expect(fileB.articles).toEqual(fileA.articles)
  })

  it('orders the result identically on both devices', () => {
    const onA = merge(local, remoteOf(remoteState))
    const onB = merge({ ...remoteState, tombstones: createEmptyTombstones() }, remoteOf(local))

    expect(onB.articles.map(a => a.url)).toEqual(onA.articles.map(a => a.url))
    expect(onB.feeds.map(f => f.url)).toEqual(onA.feeds.map(f => f.url))
  })

  it('does not mutate the state it was handed', () => {
    const localCopy = structuredClone(local)
    const remote = remoteOf(remoteState)
    const remoteCopy = structuredClone(remote)

    merge(local, remote)

    expect(local).toEqual(localCopy)
    expect(remote).toEqual(remoteCopy)
  })

  it('refuses a remote that is not a sync file', () => {
    expect(() => merge(local, '<html>not a sync file</html>')).toThrow('invalid_payload')
    expect(() => merge(local, '{"bookmarks": []}')).toThrow('invalid_payload')
  })

  it('survives a local state that is missing everything', () => {
    const merged = merge({}, null)

    expect(merged.feeds).toEqual([])
    expect(merged.articles).toEqual([])
    expect(merged.tombstones).toEqual({ feeds: {}, articles: {} })
    expect(merged.changed).toBe(false)
  })
})

describe('the additive fields — isArchived, isQuelled, filterPrompt (still format v1)', () => {
  it('writes them into the payload', () => {
    const payload = buildSyncPayload({
      feeds: [feed({ filterPrompt: 'nur KI-Themen' })],
      articles: [article({ isArchived: true, isQuelled: true })],
    }, { now: NOW })

    expect(payload.version).toBe(SYNC_VERSION)
    expect(payload.feeds[0].filterPrompt).toBe('nur KI-Themen')
    expect(payload.articles[0].isArchived).toBe(true)
    expect(payload.articles[0].isQuelled).toBe(true)
  })

  it('writes an empty filterPrompt as "" — a cleared prompt must be able to travel', () => {
    const payload = buildSyncPayload({ feeds: [feed({ filterPrompt: '' })] }, { now: NOW })

    expect(payload.feeds[0].filterPrompt).toBe('')
  })

  it('does not let an OLDER file without the fields un-archive an article', () => {
    // A device still on the previous app version writes no isArchived at all. Its write
    // is NEWER (the user read the article there) — but "the field is absent" is no
    // knowledge, not an explicit false, so the archive must survive.
    const local = {
      feeds: [],
      articles: [article({
        feedId: null,
        isArchived: true,
        isSaved: true,
        updatedAt: '2026-07-08T00:00:00.000Z',
      })],
      tombstones: createEmptyTombstones(),
    }
    const remote = {
      version: 1,
      articles: [{
        url: 'https://example.com/story-1',
        isRead: true,
        isSaved: true,
        updatedAt: '2026-07-10T00:00:00.000Z',
      }],
    }

    const merged = merge(local, remote)

    expect(merged.articles[0].isArchived).toBe(true)
    expect(merged.articles[0].isRead).toBe(true)
  })

  it('keeps a filterPrompt against an older file that never heard of it', () => {
    const local = {
      feeds: [feed({ filterPrompt: 'nur KI-Themen', updatedAt: '2026-07-08T00:00:00.000Z' })],
      articles: [],
      tombstones: createEmptyTombstones(),
    }
    const remote = {
      version: 1,
      feeds: [{ url: 'https://example.com/feed.xml', title: 'Example', updatedAt: '2026-07-10T00:00:00.000Z' }],
    }

    expect(merge(local, remote).feeds[0].filterPrompt).toBe('nur KI-Themen')
  })

  it('lets a LATER clearing of the filterPrompt win — "" is a real value', () => {
    const local = {
      feeds: [feed({ filterPrompt: 'nur KI-Themen', updatedAt: '2026-07-08T00:00:00.000Z' })],
      articles: [],
      tombstones: createEmptyTombstones(),
    }
    const remote = remoteOf({
      feeds: [feed({ filterPrompt: '', updatedAt: '2026-07-09T00:00:00.000Z' })],
    })

    expect(merge(local, remote).feeds[0].filterPrompt).toBe('')
  })

  it('round-trips all three through serialize → parse → merge', () => {
    const state = {
      feeds: [feed({ filterPrompt: 'kein Sport' })],
      articles: [article({ isArchived: true, isQuelled: true, isSaved: true })],
      tombstones: createEmptyTombstones(),
    }

    const file = serializeSyncPayload(buildSyncPayload(state, { now: NOW }))
    const merged = merge(EMPTY, file)

    expect(merged.feeds[0].filterPrompt).toBe('kein Sport')
    expect(merged.articles[0].isArchived).toBe(true)
    expect(merged.articles[0].isQuelled).toBe(true)
    expect(merged.articles[0].isSaved).toBe(true)
  })
})

describe('tombstone helpers', () => {
  it('records a deletion without mutating the input', () => {
    const before = createEmptyTombstones()
    const after = addTombstone(before, 'articles', 'https://example.com/x', NOW)

    expect(before.articles).toEqual({})
    expect(after.articles).toEqual({ 'https://example.com/x': NOW })
  })

  it('ignores a url that is not a url', () => {
    const after = addTombstone(createEmptyTombstones(), 'articles', 'javascript:alert(1)')

    expect(after.articles).toEqual({})
  })

  it('prunes by age', () => {
    const expired = new Date(Date.parse(NOW) - TOMBSTONE_MAX_AGE_MS - 1).toISOString()
    const pruned = pruneTombstones(
      { feeds: {}, articles: { 'https://example.com/x': expired } },
      { now: NOW },
    )

    expect(pruned.articles).toEqual({})
  })
})

describe('syncWithWebdav', () => {
  const settings = {
    ...DEFAULT_WEBDAV_SETTINGS,
    baseUrl: 'https://cloud.example.com/remote.php/dav/files/jd',
    username: 'jd',
    password: 'app-password',
  }
  const local = { feeds: [feed()], articles: [article()], tombstones: createEmptyTombstones() }

  beforeEach(() => {
    vi.clearAllMocks()
    isWebdavConfigured.mockImplementation(c => Boolean(c?.baseUrl && c?.username && c?.password))
  })

  it('refuses to run unconfigured', async () => {
    await expect(syncWithWebdav(local, { ...DEFAULT_WEBDAV_SETTINGS })).rejects.toThrow('not_configured')
    expect(getFile).not.toHaveBeenCalled()
  })

  it('creates the file on the first sync and guards against a racing writer', async () => {
    getFile.mockResolvedValue({ status: 404, data: null, etag: null })
    putFile.mockResolvedValue({ status: 201, etag: '"v1"' })

    const result = await syncWithWebdav(local, settings, { now: NOW })

    const [, path, body, options] = putFile.mock.calls[0]
    expect(path).toBe('')
    expect(JSON.parse(body).version).toBe(SYNC_VERSION)
    expect(options.ifNoneMatch).toBe('*')
    expect(options.etag).toBeNull()
    expect(result.pushed).toBe(2)
    expect(result.etag).toBe('"v1"')
  })

  it('sends the ETag it got back as If-Match', async () => {
    getFile.mockResolvedValue({
      status: 200,
      data: serializeSyncPayload(remoteOf({ feeds: [feed()], articles: [] })),
      etag: '"abc123"',
    })
    putFile.mockResolvedValue({ status: 204, etag: '"def456"' })

    const result = await syncWithWebdav(local, settings, { now: NOW })

    expect(putFile.mock.calls[0][3].etag).toBe('"abc123"')
    expect(result.etag).toBe('"def456"')
  })

  it('does not write when the merge changed nothing on the server', async () => {
    getFile.mockResolvedValue({
      status: 200,
      data: serializeSyncPayload(remoteOf({ feeds: [feed()], articles: [article()] })),
      etag: '"abc"',
    })

    const result = await syncWithWebdav(local, settings, { now: NOW })

    expect(putFile).not.toHaveBeenCalled()
    expect(result.pushed).toBe(0)
    expect(result.etag).toBe('"abc"')
  })

  it('merges again and retries once when the server answers 412', async () => {
    const first = serializeSyncPayload(remoteOf({ feeds: [feed()], articles: [] }))
    const second = serializeSyncPayload(remoteOf({
      feeds: [feed()],
      articles: [article({ id: 'theirs', url: 'https://example.com/story-9', publishedAt: '2026-07-04T00:00:00.000Z' })],
    }))

    getFile
      .mockResolvedValueOnce({ status: 200, data: first, etag: '"v1"' })
      .mockResolvedValueOnce({ status: 200, data: second, etag: '"v2"' })
    putFile
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 412 }))
      .mockResolvedValueOnce({ status: 204, etag: '"v3"' })

    const result = await syncWithWebdav(local, settings, { now: NOW, newId: ids() })

    expect(getFile).toHaveBeenCalledTimes(2)
    expect(putFile).toHaveBeenCalledTimes(2)
    // The retry writes against the ETag it just read, not the stale one.
    expect(putFile.mock.calls[1][3].etag).toBe('"v2"')
    // …and the article the other device wrote in the meantime survived the retry.
    expect(result.articles.map(a => a.url)).toContain('https://example.com/story-9')
    expect(result.articles.map(a => a.url)).toContain('https://example.com/story-1')
    expect(result.etag).toBe('"v3"')
  })

  it('gives up with conflict when the second write is refused too', async () => {
    getFile.mockResolvedValue({
      status: 200,
      data: serializeSyncPayload(remoteOf({ feeds: [], articles: [] })),
      etag: '"v1"',
    })
    putFile.mockRejectedValue(Object.assign(new Error('conflict'), { status: 412 }))

    await expect(syncWithWebdav(local, settings, { now: NOW })).rejects.toThrow('conflict')
    expect(putFile).toHaveBeenCalledTimes(2)
  })

  it('passes transport errors straight through and never retries them', async () => {
    getFile.mockRejectedValue(new Error('unauthorized'))

    await expect(syncWithWebdav(local, settings, { now: NOW })).rejects.toThrow('unauthorized')
    expect(getFile).toHaveBeenCalledTimes(1)
    expect(putFile).not.toHaveBeenCalled()
  })

  it('fails loudly on a file that is not ours instead of overwriting it', async () => {
    getFile.mockResolvedValue({ status: 200, data: '{"totally":"different"}', etag: '"v1"' })

    await expect(syncWithWebdav(local, settings, { now: NOW })).rejects.toThrow('invalid_payload')
    expect(putFile).not.toHaveBeenCalled()
  })

  it('reports what moved, for the toast', async () => {
    getFile.mockResolvedValue({
      status: 200,
      data: serializeSyncPayload(remoteOf({
        feeds: [feed()],
        articles: [article({ isRead: true }), article({ id: 'r2', url: 'https://example.com/story-3' })],
      })),
      etag: '"v1"',
    })
    putFile.mockResolvedValue({ status: 204, etag: '"v2"' })

    const result = await syncWithWebdav(local, settings, { now: NOW, newId: ids() })

    // Down: the new article plus the isRead flip. Up: nothing but the feed we both have…
    expect(result.pulled).toBe(2)
    expect(result.articles).toHaveLength(2)
    expect(result.articles.find(a => a.url === 'https://example.com/story-1').isRead).toBe(true)
    expect(result.changed).toBe(true)
  })
})

describe('testWebdavConnection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('treats a missing sync file as a working connection', async () => {
    testConnection.mockResolvedValue({ ok: true, status: 404, exists: false })

    await expect(testWebdavConnection({ baseUrl: 'x', username: 'u', password: 'p' }))
      .resolves.toEqual({ ok: true, status: 404, exists: false })
  })

  it('reports bad credentials', async () => {
    testConnection.mockRejectedValue(new Error('unauthorized'))

    await expect(testWebdavConnection({ baseUrl: 'x', username: 'u', password: 'p' }))
      .rejects.toThrow('unauthorized')
  })
})
