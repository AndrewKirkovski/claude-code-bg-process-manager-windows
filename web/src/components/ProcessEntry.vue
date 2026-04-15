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

const displayCwd = computed(() => {
  const cwd = props.process.cwd
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-3).join('/')
})

const envEntries = computed(() => {
  if (!props.process.env_vars) return []
  let parsed: Record<string, string>
  try { parsed = JSON.parse(props.process.env_vars) }
  catch { throw new Error(`Corrupted env_vars for process "${props.process.name}": ${props.process.env_vars}`) }
  return Object.entries(parsed)
})

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const tooltipHtml = computed(() => {
  const p = props.process
  const statusColor = p.alive ? 'var(--color-alive)' : 'var(--color-dead)'
  const exitColor = p.exit_code === 0 ? 'var(--color-exit-success)' : 'var(--color-exit-error)'
  const exitInfo = !p.alive && p.exit_code !== null
    ? ` <span style="color:${exitColor}">(exit ${p.exit_code})</span>` : ''
  const statusText = p.alive ? 'ALIVE' : `COMPLETED${exitInfo}`

  const row = (label: string, value: string) =>
    `<tr><td style="color:var(--color-secondary);padding-right:8px;white-space:nowrap;vertical-align:top">${label}</td><td style="word-break:break-all">${esc(value)}</td></tr>`

  let rows = ''
  rows += row('PID', String(p.pid))
  rows += row('Command', p.command)
  rows += row('Intent', p.intent)
  rows += row('CWD', p.cwd)
  rows += row('Started', p.started_at)
  rows += row('Log', p.log_file)
  if (envEntries.value.length) {
    rows += row('Env', envEntries.value.map(([k, v]) => `${k}=${v}`).join(', '))
  }
  const t = p.triggers
  if (t) {
    const parts: string[] = []
    if (t.config.notifyDead !== false) parts.push('death')
    if (t.config.notifyPort) parts.push('port')
    if (t.config.notifyReady) parts.push('ready')
    const pc = t.config.logTriggers?.length ?? 0
    if (pc > 0) parts.push(`${pc} log pattern${pc > 1 ? 's' : ''}`)
    if (parts.length) rows += row('Triggers', parts.join(', '))
  }

  const modeTag = p.mode === 'sync'
    ? ` <span style="color:var(--color-accent);font-size:10px">[SYNC]</span>`
    : ''
  return `<div style="font-size:12px;line-height:1.5">` +
    `<div style="font-weight:600;margin-bottom:4px">${esc(p.name)}${modeTag} <span style="color:${statusColor}">${statusText}</span></div>` +
    `<table style="border-spacing:0">${rows}</table>` +
    `</div>`
})


</script>

<template>
  <div
    class="flex items-center gap-2.5 py-2 px-4 pl-7 cursor-pointer border-l-3 transition-colors"
    :class="[
      isSelected ? 'bg-surface-3 border-l-accent' : 'border-l-transparent hover:bg-surface-3',
    ]"
    v-tooltip="{ content: tooltipHtml, html: true, placement: 'right', delay: { show: 400, hide: 0 } }"
    @click="emit('select')"
  >
    <span
      class="shrink-0 w-2.5 h-2.5 rounded-full"
      :class="process.alive
        ? 'bg-alive status-pulse'
        : process.exit_code === 0
          ? 'bg-exit-success opacity-60'
          : 'bg-exit-error opacity-60'"
    />
    <div class="flex-1 min-w-0">
      <div class="font-semibold text-[13px]">
        <span class="text-secondary font-mono text-[11px]">{{ process.pid }}</span>
        {{ process.name }}
        <span
          v-if="process.mode === 'sync'"
          class="inline-block text-[9px] font-bold px-1 py-px rounded bg-accent-subtle text-accent align-middle ml-1"
          title="Synchronous run (sync_run). Converted to background if it exceeded its timeout."
        >SYNC</span>
      </div>
      <div class="text-[11px] text-secondary truncate">
        {{ timeAgo(process.started_at) }} &middot; {{ truncate(process.command, 60) }}
      </div>
      <div class="text-[10px] text-secondary truncate opacity-70">{{ displayCwd }}</div>
      <div v-if="envEntries.length" class="flex flex-wrap gap-1 mt-0.5">
        <span
          v-for="[key, val] in envEntries" :key="key"
          class="text-[9px] px-1 py-px rounded bg-surface-3 text-secondary"
          :title="`${key}=${val}`"
        >{{ key }}={{ truncate(val, 15) }}</span>
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
