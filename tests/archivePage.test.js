import { describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import ArchivePage from '../src/pages/ArchivePage.vue'
import SavedPage from '../src/pages/SavedPage.vue'

// The pages pull in addMenu.js, which reads the f7 singleton — give it a quiet stand-in.
vi.mock('framework7-vue', () => ({
  f7: {
    actions: { create: vi.fn(() => ({ open: vi.fn() })) },
    params: { touch: { tapHold: false, tapHoldDelay: 750 } },
  },
}))

// The card's own behavior has its own tests — here it only needs to show which
// articles a page hands it, and with which context.
vi.mock('../src/components/ArticleCard.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'ArticleCard',
      props: ['article', 'sourceLabel', 'context', 'quelled'],
      render() {
        return h('div', { class: 'stub-card', 'data-context': this.context }, this.article.title)
      },
    },
  }
})

const ARTICLES = [
  { id: 's-1', title: 'Saved article', isSaved: true, isArchived: false },
  { id: 'a-1', title: 'Archived article', isSaved: true, isArchived: true },
]

/** The two store getters the pages read, with the real disjoint semantics. */
function fakeStore(articles = ARTICLES) {
  return {
    articles,
    get savedArticles() {
      return this.articles.filter(a => a.isSaved && !a.isArchived)
    },
    get archivedArticles() {
      return this.articles.filter(a => Boolean(a.isArchived))
    },
    getSourceLabel: () => 'source',
    getArticleById: id => ARTICLES.find(a => a.id === id),
  }
}

/**
 * Mount without Framework7: the f7-* components stay unresolved and render as plain
 * elements, which is all a list assertion needs. The warnings that come with that are
 * exactly the expected ones, so they are muted.
 */
function mountPage(component, store = fakeStore()) {
  const host = document.createElement('div')
  document.body.appendChild(host)

  const app = createApp({ render: () => h(component, { f7router: { navigate: vi.fn() } }) })
  app.config.warnHandler = () => {}
  app.config.globalProperties.$store = store
  app.config.globalProperties.$t = key => `[[${key}]]`
  app.mount(host)

  return host
}

describe('ArchivePage', () => {
  it('renders the archived articles, and only those', () => {
    const host = mountPage(ArchivePage)
    const cards = [...host.querySelectorAll('.stub-card')]

    expect(cards.map(el => el.textContent)).toEqual(['Archived article'])
  })

  it('hands the card the archive context — that is what makes the swipe say "restore"', () => {
    const host = mountPage(ArchivePage)
    expect(host.querySelector('.stub-card').dataset.context).toBe('archive')
  })

  it('shows its own empty state when nothing is archived', () => {
    const host = mountPage(ArchivePage, fakeStore([]))

    expect(host.textContent).toContain('[[archive.empty]]')
    expect(host.querySelector('.stub-card')).toBeNull()
  })
})

describe('SavedPage', () => {
  it('shows the reading list without the archived articles', () => {
    const host = mountPage(SavedPage)
    const cards = [...host.querySelectorAll('.stub-card')]

    expect(cards.map(el => el.textContent)).toEqual(['Saved article'])
  })

  it('hands the card the saved context', () => {
    const host = mountPage(SavedPage)
    expect(host.querySelector('.stub-card').dataset.context).toBe('saved')
  })
})
