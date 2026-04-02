<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessWithStatus } from '@/types'

const props = defineProps<{
  processes: ProcessWithStatus[]
  filter: string
}>()

const emit = defineEmits<{
  'update:filter': [value: string]
  cleanup: []
}>()

const projects = computed(() =>
  [...new Set(props.processes.map(p => p.project))].sort()
)

const filtered = computed(() =>
  props.filter ? props.processes.filter(p => p.project === props.filter) : props.processes
)

const alive = computed(() => filtered.value.filter(p => p.alive).length)
const dead = computed(() => filtered.value.length - alive.value)

function shortProject(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}
</script>

<template>
  <div class="flex items-center gap-3 px-5 py-2 bg-surface-2 border-b border-border shrink-0">
    <select
      :value="filter"
      @change="emit('update:filter', ($event.target as HTMLSelectElement).value)"
      class="text-[13px] px-2.5 py-1 rounded-md border border-border bg-surface-3 text-primary
             cursor-pointer outline-none hover:border-accent"
    >
      <option value="">All projects</option>
      <option v-for="p in projects" :key="p" :value="p">{{ shortProject(p) }}</option>
    </select>
    <button
      @click="emit('cleanup')"
      class="text-[13px] px-2.5 py-1 rounded-md border border-dead text-dead
             cursor-pointer hover:bg-dead hover:text-white transition-colors"
    >
      Cleanup dead
    </button>
    <span class="text-xs text-secondary">
      {{ filtered.length }} total, {{ alive }} alive, {{ dead }} dead
    </span>
  </div>
</template>
