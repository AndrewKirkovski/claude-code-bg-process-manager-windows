<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessWithStatus } from '@/types'
import ProcessEntry from './ProcessEntry.vue'

const props = defineProps<{
  processes: ProcessWithStatus[]
  selected: { project: string; name: string } | null
}>()

const emit = defineEmits<{
  select: [project: string, name: string]
  kill: [project: string, name: string]
  remove: [project: string, name: string]
}>()

const groups = computed(() => {
  const map = new Map<string, ProcessWithStatus[]>()
  for (const p of props.processes) {
    const list = map.get(p.project) ?? []
    list.push(p)
    map.set(p.project, list)
  }
  return map
})

function shortProject(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function isSelected(p: ProcessWithStatus): boolean {
  return props.selected?.project === p.project && props.selected?.name === p.name
}
</script>

<template>
  <div class="border-r border-border grid grid-rows-[auto_1fr] overflow-hidden min-w-0">
    <div class="px-4 py-2.5 text-xs text-secondary uppercase tracking-wide font-semibold border-b border-border">
      Processes
    </div>
    <div class="overflow-y-auto min-h-0">
      <template v-if="processes.length === 0">
        <div class="p-5 text-center text-secondary">No processes</div>
      </template>
      <div v-for="[project, procs] in groups" :key="project" class="border-b border-border">
        <div class="px-4 py-2 text-xs text-accent bg-surface font-semibold sticky top-0 cursor-pointer hover:bg-surface-2">
          {{ shortProject(project) }}
        </div>
        <ProcessEntry
          v-for="p in procs"
          :key="p.name"
          :process="p"
          :is-selected="isSelected(p)"
          @select="emit('select', p.project, p.name)"
          @kill="emit('kill', p.project, p.name)"
          @remove="emit('remove', p.project, p.name)"
        />
      </div>
    </div>
  </div>
</template>
