import { createApp } from 'vue'
import Framework7 from 'framework7/lite-bundle'
import Framework7Vue, { registerComponents } from 'framework7-vue/bundle'
import 'framework7/css/bundle'

import App from './App.vue'
import AppIcon from './components/AppIcon.vue'
import SecretInput from './components/SecretInput.vue'
import { i18n } from './i18n/index.js'
import { pinia, store } from './store/index.js'
import './css/app.css'

Framework7.use(Framework7Vue)

const app = createApp(App)

app.use(i18n)
app.use(pinia)

// Pinia's own way would be mapState/mapActions per component; `$store` keeps every
// template and method unchanged and is the same store instance Pinia DevTools shows.
app.config.globalProperties.$store = store
app.component('AppIcon', AppIcon)
app.component('SecretInput', SecretInput)

registerComponents(app)

app.mount('#app')
