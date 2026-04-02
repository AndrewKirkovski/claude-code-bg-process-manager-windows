<script setup lang="ts">
import ThemeToggle from './ThemeToggle.vue'

defineProps<{
  connected: boolean
}>()
</script>

<template>
  <header class="flex items-center justify-between px-5 py-3 bg-surface-2 border-b border-border shrink-0">
    <h1 class="text-base font-semibold">
      bg-manager
      <span class="text-secondary font-normal ml-2 text-[13px]">process dashboard</span>
    </h1>
    <div class="flex items-center gap-3">
      <span
        class="w-2 h-2 rounded-full inline-block"
        :class="connected ? 'bg-alive' : 'bg-dead'"
        :title="connected ? 'SSE connected' : 'SSE disconnected'"
      />
      <span class="text-xs text-secondary">{{ connected ? 'connected' : 'disconnected' }}</span>
      <ThemeToggle />
    </div>
  </header>
</template>
