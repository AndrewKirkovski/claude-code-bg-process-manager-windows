<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessWithStatus } from '@/types'

const props = defineProps<{
  process: ProcessWithStatus
  isSelected: boolean
}>()

const emit = defineEmits<{
  select: []
  kill: []
  remove: []
}>()

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h ago`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

const triggerLabels = computed(() => {
  const t = props.process.triggers
  if (!t) return []
  const labels: string[] = []
  if (t.config.notifyDead !== false) labels.push('death')
  if (t.config.notifyPort) labels.push('port')
  if (t.config.notifyReady) labels.push('ready')
  const patternCount = t.config.logTriggers?.length ?? 0
  if (patternCount > 0) labels.push(`${patternCount} pattern${patternCount > 1 ? 's' : ''}`)
  return labels
})

</script>

<template>
  <div
    class="flex items-center gap-2.5 py-2 px-4 pl-7 cursor-pointer border-l-3 transition-colors"
    :class="[
      isSelected ? 'bg-surface-3 border-l-accent' : 'border-l-transparent hover:bg-surface-3',
    ]"
    @click="emit('select')"
  >
    <span
      class="text-[11px] font-bold px-1.5 py-0.5 rounded text-center min-w-[44px] uppercase"
      :class="process.alive
        ? 'bg-alive-subtle text-alive'
        : 'bg-dead-subtle text-dead'"
    >
      {{ process.alive ? 'alive' : 'dead' }}
    </span>
    <div class="flex-1 min-w-0">
      <div class="font-semibold text-[13px]">{{ process.name }}</div>
      <div class="text-[11px] text-secondary truncate">
        PID {{ process.pid }} &middot; {{ timeAgo(process.started_at) }} &middot; {{ truncate(process.command, 60) }}
      </div>
      <div v-if="triggerLabels.length" class="flex gap-1 mt-0.5">
        <span
          v-for="label in triggerLabels" :key="label"
          class="text-[9px] px-1 py-px rounded bg-accent-subtle text-accent"
        >{{ label }}</span>
      </div>
    </div>
    <button
      @click.stop="process.alive ? emit('kill') : emit('remove')"
      class="text-secondary hover:text-dead hover:bg-dead-subtle
             text-base px-1.5 py-0.5 rounded leading-none cursor-pointer"
      :title="process.alive ? 'Kill process' : 'Remove entry'"
    >&times;</button>
  </div>
</template>
