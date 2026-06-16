<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import type { ProcessWithStatus } from '@/types'
import LogContent from './LogContent.vue'
import { useLogStream } from '@/composables/useLogStream'
import { API_BASE } from '@/api'
import { stripAnsi, copyToClipboard } from '@/utils'
import { statusText, detailRows } from '@/process-details'

const props = defineProps<{
  selected: { project: string; name: string } | null
  processes: ProcessWithStatus[]
  restart: (project: string, name: string) => Promise<void>
}>()

const autoScroll = ref(true)
const logContentRef = ref<InstanceType<typeof LogContent> | null>(null)

const selectedProcess = computed(() => {
  if (!props.selected) return null
  return props.processes.find(
    p => p.project === props.selected!.project && p.name === props.selected!.name,
  ) ?? null
})

const selectedRef = computed(() => props.selected)
const { reload } = useLogStream(selectedRef, logContentRef, autoScroll)

// Transient "Copied" feedback keyed by button id.
const copied = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
function flashCopied(id: string) {
  copied.value = id
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = null }, 1500)
}
onUnmounted(() => { if (copiedTimer) clearTimeout(copiedTimer) })

const restarting = ref(false)

async function onRestart() {
  const p = selectedProcess.value
  if (!p || !p.alive || restarting.value) return
  if (!confirm(`Restart "${p.name}"? The running process will be killed and re-spawned with the same command.`)) return
  restarting.value = true
  try {
    await props.restart(p.project, p.name)
    reload() // clear the stale buffer and re-read the fresh (truncated) log
  } finally {
    restarting.value = false
  }
}

async function copyCmd() {
  const p = selectedProcess.value
  if (!p) return
  if (await copyToClipboard(p.command)) flashCopied('cmd')
}

function buildDetails(p: ProcessWithStatus): string {
  const modeTag = p.mode === 'sync' ? ' [SYNC]' : ''
  const header = `${p.name}${modeTag} — ${statusText(p)}`
  const rows = detailRows(p).map(({ label, value }) => `${(label + ':').padEnd(9)} ${value}`)
  return [header, ...rows].join('\n')
}

async function copyDetails() {
  const p = selectedProcess.value
  if (!p) return
  if (await copyToClipboard(buildDetails(p))) flashCopied('details')
}

async function copyLog() {
  const p = selectedProcess.value
  if (!p) return
  try {
    const url = `${API_BASE}/api/processes/${encodeURIComponent(p.project)}/${encodeURIComponent(p.name)}/logs?full=1`
    const res = await fetch(url)
    if (!res.ok) return
    const data = await res.json()
    if (await copyToClipboard(stripAnsi(data.content || ''))) flashCopied('log')
  } catch { /* server may be down */ }
}

const btnClass =
  'text-xs px-2 py-0.5 rounded border border-border text-secondary ' +
  'hover:bg-surface-3 hover:text-primary cursor-pointer transition-colors'
</script>

<template>
  <div class="grid grid-rows-[auto_1fr] overflow-hidden min-w-0">
    <!-- Log header -->
    <div class="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-border min-h-[42px]">
      <div v-if="selectedProcess" class="text-[13px] min-w-0 truncate">
        <span class="font-semibold">{{ selectedProcess.name }}</span>
        <span class="text-secondary ml-2">PID {{ selectedProcess.pid }}</span>
        <span class="ml-2" :class="selectedProcess.alive ? 'text-alive' : 'text-dead'">
          {{ selectedProcess.alive ? 'ALIVE' : 'COMPLETED' }}
        </span>
        <span
          v-if="!selectedProcess.alive && selectedProcess.exit_code !== null"
          class="ml-1"
          :class="selectedProcess.exit_code === 0 ? 'text-exit-success' : 'text-exit-error'"
        >
          (exit {{ selectedProcess.exit_code }})
        </span>
      </div>
      <div v-else class="text-secondary text-[13px]">Select a process to view logs</div>

      <div class="flex items-center gap-1.5 shrink-0">
        <template v-if="selectedProcess">
          <button
            v-if="selectedProcess.alive"
            @click="onRestart"
            :disabled="restarting"
            class="text-xs px-2 py-0.5 rounded border border-accent text-accent
                   hover:bg-accent hover:text-white cursor-pointer transition-colors
                   disabled:opacity-40 disabled:cursor-default"
            title="Kill and re-spawn with the same command, working dir and env"
          >{{ restarting ? 'Restarting…' : 'Restart' }}</button>
          <button
            @click="copyCmd"
            :class="[btnClass, copied === 'cmd' && 'text-alive border-alive']"
            title="Copy the command line"
          >{{ copied === 'cmd' ? 'Copied' : 'Copy cmd' }}</button>
          <button
            @click="copyDetails"
            :class="[btnClass, copied === 'details' && 'text-alive border-alive']"
            title="Copy all process details"
          >{{ copied === 'details' ? 'Copied' : 'Copy details' }}</button>
          <button
            @click="copyLog"
            :class="[btnClass, copied === 'log' && 'text-alive border-alive']"
            title="Copy the entire log (ANSI stripped)"
          >{{ copied === 'log' ? 'Copied' : 'Copy log' }}</button>
        </template>
        <label class="text-xs text-secondary flex items-center gap-1 cursor-pointer">
          <input type="checkbox" v-model="autoScroll" class="cursor-pointer"> Auto-scroll
        </label>
      </div>
    </div>
    <!-- Log body -->
    <div class="overflow-hidden grid grid-rows-[1fr] min-h-0">
      <div
        v-if="!selected"
        class="flex items-center justify-center text-secondary text-sm"
      >
        No process selected
      </div>
      <LogContent v-show="selected" ref="logContentRef" />
    </div>
  </div>
</template>
