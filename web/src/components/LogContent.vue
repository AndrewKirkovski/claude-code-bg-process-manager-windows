<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { xtermTheme } from '@/composables/useTheme'

const containerEl = ref<HTMLDivElement>()
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (!containerEl.value) return

  fitAddon = new FitAddon()

  terminal = new Terminal({
    theme: xtermTheme,
    fontFamily: "'Fira Mono', Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.0,
    scrollback: 10000,
    convertEol: true,
    disableStdin: true,
    cursorStyle: 'bar',
    cursorBlink: false,
    cursorInactiveStyle: 'none',
  })

  terminal.loadAddon(fitAddon)
  terminal.open(containerEl.value)
  fitAddon.fit()

  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit()
  })
  resizeObserver.observe(containerEl.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

function write(data: string) {
  terminal?.write(data)
}

function clear() {
  terminal?.clear()
  terminal?.reset()
}

function scrollToBottom() {
  terminal?.scrollToBottom()
}

defineExpose({ write, clear, scrollToBottom })
</script>

<template>
  <div class="h-full w-full min-h-0 overflow-hidden px-3 py-2 bg-surface">
    <div ref="containerEl" class="h-full w-full" />
  </div>
</template>
