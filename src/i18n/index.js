import { createI18n } from 'vue-i18n'
import de from './de.js'
import en from './en.js'

const locale = navigator.language?.startsWith('de') ? 'de' : 'en'

export const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en',
  messages: { de, en },
})
