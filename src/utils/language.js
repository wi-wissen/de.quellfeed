/**
 * The primary subtag of a declared language ('de-AT' → 'de', 'DE_de' → 'de'), or ''
 * when the value is missing or not a language tag. Deliberately strict — the value
 * decides whether the translate button is demoted into the overflow menu, and a
 * wrongly "known" language would hide it exactly when it is needed.
 */
export function normalizeLanguageTag(value) {
  const match = String(value || '').trim().toLowerCase().match(/^([a-z]{2,3})(?=$|[-_,;\s])/)
  return match ? match[1] : ''
}
