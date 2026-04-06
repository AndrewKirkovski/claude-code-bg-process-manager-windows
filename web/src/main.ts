import { createApp } from 'vue'
import FloatingVue from 'floating-vue'
import 'floating-vue/dist/style.css'
import App from './App.vue'
import router from './router'
import { initTheme } from './composables/useTheme'
import './style.css'

initTheme()

createApp(App).use(router).use(FloatingVue).mount('#app')
