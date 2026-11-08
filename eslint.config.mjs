import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['dist/**', 'android/**', 'ios/**', 'docs/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
    },
    rules: {
      // Framework7 page components are named by the router, not by a component name.
      'vue/multi-word-component-names': 'off',
      // AppIcon renders inline SVG markup from our own bundle — never foreign data.
      'vue/no-v-html': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Framework7 always injects f7router/f7route into page components.
      'vue/require-default-prop': 'off',
      // Deliberate: the sync and AI modules rethrow a bare error code and DROP the
      // transport error, whose message may echo the request — API key included.
      // Attaching it as `cause` would carry it straight back into every log line.
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['tests/**', '*.config.mjs', 'vite.config.mjs', 'scripts/**', 'capacitor.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
  },
  {
    files: ['tests/**'],
    rules: { 'vue/one-component-per-file': 'off', 'vue/component-definition-name-casing': 'off' },
  },
  {
    files: ['capacitor.config.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
  // Formatting is Prettier's job; this switches off every rule that would fight it.
  prettier,
]
