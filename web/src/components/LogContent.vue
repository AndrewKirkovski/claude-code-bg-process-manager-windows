<script setup lang="ts">
import { ref } from 'vue'

const el = ref<HTMLDivElement>()
const MAX_NODES = 8000

function setContent(html: string) {
  if (el.value) el.value.innerHTML = html
}

function appendChunk(html: string) {
  if (!el.value) return
  el.value.insertAdjacentHTML('beforeend', html)
  // Cap DOM size
  while (el.value.childNodes.length > MAX_NODES) {
    el.value.removeChild(el.value.firstChild!)
  }
}

function scrollToBottom() {
  if (el.value) {
    el.value.scrollTop = el.value.scrollHeight
  }
}

defineExpose({ setContent, appendChunk, scrollToBottom })
</script>

<template>
  <div
    ref="el"
    class="log-font overflow-y-auto px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap
           break-all bg-surface min-h-0"
  />
</template>
