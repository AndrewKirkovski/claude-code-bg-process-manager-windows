import { ref } from 'vue'
import type { ITheme } from '@xterm/xterm'

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

// ── xterm terminal theme (OneDark Pro) ──
// Always rendered dark; light mode uses CSS filter: invert(1) hue-rotate(180deg)

export const xtermTheme: ITheme = {
  background: 'transparent',
  foreground: '#abb2bf',
  cursor: '#abb2bf',
  cursorAccent: '#282c34',
  selectionBackground: 'rgba(74, 165, 240, 0.25)',
  black: '#3f4451',
  red: '#e05561',
  green: '#8cc265',
  yellow: '#d18f52',
  blue: '#4aa5f0',
  magenta: '#c162de',
  cyan: '#42b3c2',
  white: '#d7dae0',
  brightBlack: '#4f5666',
  brightRed: '#ff616e',
  brightGreen: '#a5e075',
  brightYellow: '#f0a45d',
  brightBlue: '#4dc4ff',
  brightMagenta: '#de73ff',
  brightCyan: '#4cd1e0',
  brightWhite: '#e6e6e6',
}
