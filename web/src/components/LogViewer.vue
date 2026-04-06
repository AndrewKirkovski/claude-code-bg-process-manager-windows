<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ProcessWithStatus } from '@/types'
import LogContent from './LogContent.vue'
import { useLogStream } from '@/composables/useLogStream'

const props = defineProps<{
  selected: { project: string; name: string } | null
  processes: ProcessWithStatus[]
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
useLogStream(selectedRef, logContentRef, autoScroll)
</script>

<template>
  <div class="grid grid-rows-[auto_1fr] overflow-hidden min-w-0">
    <!-- Log header -->
    <div class="px-4 py-2.5 flex items-center justify-between border-b border-border min-h-[42px]">
      <div v-if="selectedProcess" class="text-[13px]">
        <span class="font-semibold">{{ selectedProcess.name }}</span>
        <span class="text-secondary ml-2">PID {{ selectedProcess.pid }}</span>
        <span class="ml-2" :class="selectedProcess.alive ? 'text-alive' : 'text-dead'">
          {{ selectedProcess.alive ? 'ALIVE' : 'DEAD' }}
        </span>
        <span v-if="!selectedProcess.alive && selectedProcess.exit_code !== null" class="text-secondary ml-1">
          (exit {{ selectedProcess.exit_code }})
        </span>
      </div>
      <div v-else class="text-secondary text-[13px]">Select a process to view logs</div>
      <label class="text-xs text-secondary flex items-center gap-1 cursor-pointer">
        <input type="checkbox" v-model="autoScroll" class="cursor-pointer"> Auto-scroll
      </label>
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
