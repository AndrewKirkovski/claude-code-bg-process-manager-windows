<script setup lang="ts">
import { ref, computed } from 'vue'
import AppHeader from './components/AppHeader.vue'
import Toolbar from './components/Toolbar.vue'
import ProcessList from './components/ProcessList.vue'
import LogViewer from './components/LogViewer.vue'
import { useProcesses } from './composables/useProcesses'

const { processes, connected, killProcess, cleanup } = useProcesses()

const selected = ref<{ project: string; name: string } | null>(null)
const projectFilter = ref('')

const filteredProcesses = computed(() =>
  projectFilter.value
    ? processes.value.filter(p => p.project === projectFilter.value)
    : processes.value,
)

function onSelect(project: string, name: string) {
  selected.value = { project, name }
}

async function onKill(project: string, name: string) {
  if (!confirm(`Kill process "${name}"?`)) return
  await killProcess(project, name)
}
</script>

<template>
  <div class="h-screen flex flex-col bg-surface text-primary overflow-hidden">
    <AppHeader :connected="connected" />
    <Toolbar
      :processes="processes"
      :filter="projectFilter"
      @update:filter="projectFilter = $event"
      @cleanup="cleanup"
    />
    <main class="flex-1 grid grid-cols-[420px_1fr] overflow-hidden max-md:grid-cols-1 max-md:grid-rows-[40vh_1fr]">
      <ProcessList
        :processes="filteredProcesses"
        :selected="selected"
        @select="onSelect"
        @kill="onKill"
        @remove="killProcess"
      />
      <LogViewer
        :selected="selected"
        :processes="processes"
      />
    </main>
  </div>
</template>
