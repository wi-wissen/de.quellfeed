<template>
  <span
    :class="['app-icon', size && `app-icon--${size}`]"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    v-html="svg"
  ></span>
</template>

<script>
import { getIconSvg } from '../utils/icons.js'

export default {
  name: 'AppIcon',

  props: {
    name: {
      type: String,
      required: true,
    },
    size: {
      type: String,
      default: 'md',
    },
    label: {
      type: String,
      default: '',
    },
  },

  computed: {
    // v-html mit einer Konstante aus dem eigenen Bundle — nie mit Fremddaten.
    svg() {
      return getIconSvg(this.name)
    },
  },
}
</script>
