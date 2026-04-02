import { createApp } from 'vue'
import App from './App.vue'
import { initTheme } from './composables/useTheme'
import './style.css'

// Sync theme before mount to prevent FOUC
initTheme()

createApp(App).mount('#app')
