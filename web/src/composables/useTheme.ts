import { ref } from 'vue'

const STORAGE_KEY = 'bg-manager-theme'
const isDark = ref(true)

export function initTheme() {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored !== null) {
    isDark.value = stored === 'dark'
  } else {
    isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  applyTheme()
}

function applyTheme() {
  document.documentElement.classList.toggle('dark', isDark.value)
}

export function useTheme() {
  function toggleTheme() {
    isDark.value = !isDark.value
    localStorage.setItem(STORAGE_KEY, isDark.value ? 'dark' : 'light')
    applyTheme()
  }

  return { isDark, toggleTheme }
}
