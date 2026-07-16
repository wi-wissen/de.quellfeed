import { describe, expect, it } from 'vitest'
import { primaryLifecycleAction } from '../src/utils/articleLifecycle.js'

/**
 * The lifecycle the bottom tabs spell out: Feed -> Leseliste -> Archiv. The reading
 * view's primary button must offer exactly the NEXT step — the reported bug was an
 * unsaved feed article greeting the reader with "archive" before it was ever saved.
 */
describe('primaryLifecycleAction', () => {
  it('offers SAVE on an unsaved feed article — never archive', () => {
    expect(primaryLifecycleAction({ feedId: 'f1', isSaved: false, isArchived: false })).toBe('save')
  })

  it('offers ARCHIVE once the article is on the reading list', () => {
    expect(primaryLifecycleAction({ feedId: 'f1', isSaved: true, isArchived: false })).toBe('archive')
  })

  it('offers RESTORE on an archived article', () => {
    expect(primaryLifecycleAction({ feedId: 'f1', isSaved: true, isArchived: true })).toBe('restore')
  })

  it('starts standalone links at ARCHIVE — they are saved by definition', () => {
    expect(primaryLifecycleAction({ feedId: null, isSaved: true, isArchived: false })).toBe('archive')
  })

  it('trusts isArchived even if isSaved is inconsistent — archived means kept', () => {
    expect(primaryLifecycleAction({ feedId: 'f1', isSaved: false, isArchived: true })).toBe('restore')
  })

  it('returns null without an article', () => {
    expect(primaryLifecycleAction(null)).toBeNull()
  })

  it('walks the whole cycle: save -> archive -> restore -> archive', () => {
    const article = { feedId: 'f1', isSaved: false, isArchived: false }
    expect(primaryLifecycleAction(article)).toBe('save')

    article.isSaved = true // saved -> on the reading list
    expect(primaryLifecycleAction(article)).toBe('archive')

    article.isArchived = true // archived -> in the archive
    expect(primaryLifecycleAction(article)).toBe('restore')

    article.isArchived = false // restored -> back on the reading list
    expect(primaryLifecycleAction(article)).toBe('archive')
  })
})
