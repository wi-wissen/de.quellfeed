<template>
  <f7-page name="settings-appearance" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.appearance.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-block-title>{{ $t('settings.theme') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item
        v-for="option in themeOptions"
        :key="option.value"
        radio
        name="theme"
        :value="option.value"
        :checked="theme === option.value"
        :title="$t(`settings.themeOptions.${option.value}`)"
        @change="$store.setTheme(option.value)"
      ></f7-list-item>
    </f7-list>

    <!-- Every font renders in itself — a name set in the system font tells you
         nothing about what you are picking. -->
    <f7-block-title>{{ $t('settings.readingFont') }}</f7-block-title>
    <f7-list strong inset dividers>
      <f7-list-item
        v-for="font in readingFonts"
        :key="font.id"
        radio
        name="reading-font"
        :value="font.id"
        :checked="readingFont === font.id"
        @change="$store.setReadingFont(font.id)"
      >
        <template #title>
          <span :style="fontRowStyle(font)">{{ font.label }}</span>
        </template>
      </f7-list-item>
    </f7-list>

    <f7-block-title>{{ $t('settings.readingFontSize') }}</f7-block-title>
    <f7-segmented strong class="reading-segmented">
      <f7-button
        v-for="step in readingFontScales"
        :key="step.value"
        :active="readingFontScale === step.value"
        :style="{ fontSize: `calc(0.55rem + ${step.value} * 0.6rem)` }"
        :aria-label="`${step.percent} %`"
        @click="$store.setReadingFontSize(step.value)"
      >
        A
      </f7-button>
    </f7-segmented>
    <f7-block-footer>
      {{ $t('settings.readingFontSizeHint', { percent: readingFontPercent }) }}
    </f7-block-footer>

    <f7-block-title>{{ $t('settings.readingWidth') }}</f7-block-title>
    <f7-segmented strong class="reading-segmented">
      <f7-button
        v-for="width in readingWidths"
        :key="width.id"
        :active="readingWidth === width.id"
        @click="$store.setReadingWidth(width.id)"
      >
        {{ $t(`settings.readingWidths.${width.id}`) }}
      </f7-button>
    </f7-segmented>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import {
  READING_FONTS,
  READING_FONT_SCALES,
  READING_WIDTHS,
  injectReadingFonts,
} from '../../utils/fonts.js'

export default {
  name: 'AppearanceSettings',

  mixins: [hidesTabbar],

  data() {
    return {
      readingFonts: READING_FONTS,
      readingFontScales: READING_FONT_SCALES,
      readingWidths: READING_WIDTHS,
      themeOptions: [
        { value: 'system' },
        { value: 'light' },
        { value: 'dark' },
        { value: 'slate' },
        { value: 'sepia' },
      ],
    }
  },

  mounted() {
    // Puts every reading font's @font-face into the app document so the list can
    // render each name in its own typeface. Idempotent, local, no network.
    injectReadingFonts()
  },

  computed: {
    theme() {
      return this.$store.settings.theme
    },
    readingFont() {
      return this.$store.readingPrefs.font
    },
    readingFontScale() {
      return this.$store.readingPrefs.fontScale
    },
    readingFontPercent() {
      return Math.round(this.readingFontScale * 100)
    },
    readingWidth() {
      return this.$store.readingPrefs.width
    },
  },

  methods: {
    // Playwrite is small-bodied, OpenDyslexic is oversized — without the per-font
    // factor the list would be a row of unreadable extremes.
    fontRowStyle(font) {
      return {
        fontFamily: font.stack,
        fontSize: `calc(1rem * ${font.sizeFactor})`,
        lineHeight: 1.4,
      }
    },
  },
}
</script>
