<template>
  <f7-page name="settings-ai" @page:beforein="onPageIn" @page:beforeout="onPageOut">
    <f7-navbar>
      <f7-nav-left>
        <f7-link back class="nav-icon-link">
          <AppIcon name="arrow-back-outline" :label="$t('common.back')" />
        </f7-link>
      </f7-nav-left>
      <f7-nav-title>{{ $t('settings.sections.ai.title') }}</f7-nav-title>
    </f7-navbar>

    <f7-block-header>{{ $t('settings.ai.hint') }}</f7-block-header>

    <f7-list strong inset dividers>
      <f7-list-item
        v-for="preset in aiPresets"
        :key="preset.id"
        radio
        name="ai-preset"
        :value="preset.id"
        :checked="activePreset === preset.id"
        :title="$t(`settings.ai.presets.${preset.id}.title`)"
        :footer="$t(`settings.ai.presets.${preset.id}.subtitle`)"
        @change="onPresetChange(preset.id)"
      ></f7-list-item>
    </f7-list>

    <f7-list strong inset dividers form>
      <!-- Editable for every preset: the presets are a starting point, not a cage. -->
      <f7-list-input
        type="text"
        outline
        floating-label
        :label="$t('settings.ai.model')"
        :placeholder="$t('settings.ai.modelPlaceholder')"
        :value="ai.model"
        clear-button
        @input="onChange('model', $event.target.value)"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <f7-list-input
        v-if="isCustom"
        type="url"
        outline
        floating-label
        :label="$t('settings.ai.baseUrl')"
        :placeholder="$t('settings.ai.baseUrlPlaceholder')"
        :value="ai.baseUrl"
        clear-button
        @input="onChange('baseUrl', $event.target.value)"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
      ></f7-list-input>

      <SecretInput
        :label="$t('settings.ai.apiKey')"
        :placeholder="$t('settings.ai.apiKeyPlaceholder')"
        :value="ai.apiKey"
        @input="onChange('apiKey', $event)"
      ></SecretInput>
    </f7-list>

    <!-- One footer under the list it belongs to, not two stacked blocks: both lines are
         notes about the credentials above them. -->
    <f7-block-footer v-if="isCustomModel || presetNote">
      <p v-if="isCustomModel">{{ $t('settings.ai.customModel', { endpoint: endpointLabel }) }}</p>
      <p v-if="presetNote">{{ presetNote }}</p>
    </f7-block-footer>

    <f7-block-title>{{ $t('settings.ai.features') }}</f7-block-title>
    <f7-block-header>{{ $t('settings.ai.featuresHint') }}</f7-block-header>

    <!-- Not a scanner — the system camera does the scanning. This block only has to
         make the transfer path discoverable from where people set up their key. -->
    <f7-block-title>{{ $t('settings.ai.transfer.title') }}</f7-block-title>
    <f7-block-header>{{ $t('settings.ai.transfer.hint') }}</f7-block-header>
  </f7-page>
</template>

<script>
import { hidesTabbar } from '../../utils/tabbar.js'
import { AI_PRESETS, getAiProvider, getAiPreset, matchPreset } from '../../utils/ai.js'

export default {
  name: 'AiSettings',

  mixins: [hidesTabbar],

  data() {
    return {
      aiPresets: AI_PRESETS,
    }
  },

  computed: {
    ai() {
      return this.$store.settings.ai
    },
    isCustom() {
      return this.ai.provider === 'custom'
    },
    activePreset() {
      return matchPreset(this.ai)
    },
    // No preset matches → the model was hand-edited. Say so, rather than leaving a
    // radio checked that no longer describes what will actually be called.
    isCustomModel() {
      return this.activePreset === null && Boolean(this.ai.model)
    },
    endpointLabel() {
      return getAiProvider(this.ai.provider)?.label || this.ai.provider
    },
    presetNote() {
      const note = getAiPreset(this.activePreset)?.note
      return note ? this.$t(`settings.ai.notes.${note}`) : ''
    },
  },

  methods: {
    async onChange(key, value) {
      await this.$store.setAiSettings({ [key]: value })
    },
    async onPresetChange(presetId) {
      const preset = getAiPreset(presetId)
      if (!preset) return

      // Custom keeps whatever model was typed; the others carry their own, because
      // an OpenRouter slug left over on OpenAI would only fail once you use it.
      await this.$store.setAiSettings({
        provider: preset.provider,
        ...(preset.id === 'custom' ? {} : { model: preset.model }),
      })
    },
  },
}
</script>
