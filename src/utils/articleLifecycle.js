/**
 * The one primary action an article offers next, following its lifecycle:
 *
 *   Feed  --save-->  Leseliste  --archive-->  Archiv  --restore-->  Leseliste
 *
 * The reading view's toolbar shows exactly this stage's verb and nothing else. An
 * UNSAVED article must offer "save", not "archive": archiving is "done with this,
 * keep it" — a stage you reach after deciding to keep it at all. (Shipping "archive"
 * as the first button on unread feed articles was the bug this module pins down.)
 *
 * Standalone links (feedId null) are saved by definition, so they start at 'archive'.
 */
export function primaryLifecycleAction(article) {
  if (!article) return null
  if (article.isArchived) return 'restore'
  if (article.isSaved) return 'archive'
  return 'save'
}
