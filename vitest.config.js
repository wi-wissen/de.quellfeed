import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // Ohne das Vue-Plugin kann ein Test keine .vue-Datei importieren — und genau das
  // brauchen wir, um zu prüfen, dass AppIcon wirklich ein <svg> in den DOM legt.
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
