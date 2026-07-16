<template>
  <!-- A password-style list input with the usual eye toggle. Every credential field in
       the app goes through this component, so keys and passwords behave identically
       everywhere: masked by default, revealed only deliberately, and the reveal never
       outlives the page.

       The button lives in the `input` slot — inside .item-input-wrap, the only ancestor
       that is position:relative AND exactly as wide as the field — and is positioned
       absolutely at its right edge. The `content-end` slot would render it NEXT TO the
       field instead of inside it. No clear-button: it would occupy the same corner. -->
  <f7-list-input
    class="secret-input"
    :type="revealed ? 'text' : 'password'"
    outline
    floating-label
    :label="label"
    :placeholder="placeholder"
    :value="value"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    @input="$emit('input', $event.target.value)"
  >
    <template #input>
      <button
        type="button"
        class="secret-input__toggle"
        :aria-label="revealed ? $t('common.hideSecret') : $t('common.showSecret')"
        :aria-pressed="revealed ? 'true' : 'false'"
        @click="revealed = !revealed"
      >
        <AppIcon :name="revealed ? 'eye-off-outline' : 'eye-outline'" />
      </button>
    </template>
  </f7-list-input>
</template>

<script>
export default {
  name: 'SecretInput',

  props: {
    label: {
      type: String,
      required: true,
    },
    value: {
      type: String,
      default: '',
    },
    placeholder: {
      type: String,
      default: '',
    },
  },

  emits: ['input'],

  data() {
    return {
      // Deliberately plain data, not persisted: leaving the page re-masks the secret.
      revealed: false,
    }
  },
}
</script>
