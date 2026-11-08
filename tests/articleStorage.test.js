import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/storage.js', () => {
  const prefs = new Map()
  return {
    __prefs: prefs,
    storageGet: vi.fn(async key => (prefs.has(key) ? prefs.get(key) : null)),
    storageSet: vi.fn(async (key, value) => { prefs.set(key, value) }),
    storageRemove: vi.fn(async key => { prefs.delete(key) }),
  }
})

const { __fs, Filesystem } = await import('@capacitor/filesystem')
const { __prefs } = await import('../src/utils/storage.js')
const { loadArticles, saveArticles, _resetArticleStorage } = await import('../src/utils/articleStorage.js')

const article = (id, extra = {}) => ({ id, url: `https://example.com/${id}`, title: id, cachedHtml: null, ...extra })

beforeEach(() => {
  __fs.clear()
  __prefs.clear()
  _resetArticleStorage()
  vi.clearAllMocks()
})

describe('articleStorage', () => {
  it('keeps the offline HTML out of the list file, one file per article', async () => {
    await saveArticles([article('a', { cachedHtml: '<p>A</p>' }), article('b')])

    const meta = JSON.parse(__fs.get('quell/articles.json'))
    expect(meta.articles.map(a => a.id)).toEqual(['a', 'b'])
    expect(meta.articles[0]).not.toHaveProperty('cachedHtml')
    expect(meta.html).toEqual(['a'])
    expect(__fs.get('quell/html/a.html')).toBe('<p>A</p>')
    expect(__fs.has('quell/html/b.html')).toBe(false)
  })

  it('round-trips, cachedHtml included', async () => {
    await saveArticles([article('a', { cachedHtml: '<p>A</p>', isSaved: true }), article('b')])
    _resetArticleStorage()

    const loaded = await loadArticles()
    expect(loaded).toEqual([
      article('a', { cachedHtml: '<p>A</p>', isSaved: true }),
      article('b'),
    ])
  })

  it('rewrites an HTML file only when it changed, and deletes it when it is gone', async () => {
    const list = [article('a', { cachedHtml: '<p>A</p>' })]
    await saveArticles(list)
    Filesystem.writeFile.mockClear()

    list[0].isRead = true
    await saveArticles(list)
    const htmlWrites = Filesystem.writeFile.mock.calls.filter(([o]) => o.path.endsWith('.html'))
    expect(htmlWrites).toHaveLength(0)

    list[0].cachedHtml = null
    await saveArticles(list)
    expect(__fs.has('quell/html/a.html')).toBe(false)

    await saveArticles([])
    expect(JSON.parse(__fs.get('quell/articles.json')).articles).toEqual([])
  })

  it('moves the old Preferences entry over on first start and removes it', async () => {
    __prefs.set('quell:articles', [article('old', { cachedHtml: '<p>alt</p>' })])

    const loaded = await loadArticles()

    expect(loaded.map(a => a.id)).toEqual(['old'])
    expect(__prefs.has('quell:articles')).toBe(false)
    expect(__fs.get('quell/html/old.html')).toBe('<p>alt</p>')
  })

  it('falls back to the temp file when a save was interrupted after deleting the list', async () => {
    await saveArticles([article('a')])
    __fs.set('quell/articles.json.tmp', __fs.get('quell/articles.json'))
    __fs.delete('quell/articles.json')
    _resetArticleStorage()

    expect((await loadArticles()).map(a => a.id)).toEqual(['a'])
  })

  it('never builds a path from a hostile id', async () => {
    await saveArticles([article('../../evil', { cachedHtml: 'x' })])
    expect([...__fs.keys()].some(p => p.includes('..'))).toBe(false)
  })

  it('collapses a burst of saves into few writes of the newest state', async () => {
    const list = [article('a')]
    const saves = []
    for (let i = 0; i < 10; i++) {
      list[0].title = `t${i}`
      saves.push(saveArticles(list))
    }
    await Promise.all(saves)

    const listWrites = Filesystem.writeFile.mock.calls.filter(([o]) => o.path.endsWith('.tmp'))
    expect(listWrites.length).toBeLessThanOrEqual(2)
    expect(JSON.parse(__fs.get('quell/articles.json')).articles[0].title).toBe('t9')
  })
})
