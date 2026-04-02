<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '@/components/AppHeader.vue'
import Toolbar from '@/components/Toolbar.vue'
import ProcessList from '@/components/ProcessList.vue'
import LogViewer from '@/components/LogViewer.vue'
import { useProcesses } from '@/composables/useProcesses'

const route = useRoute()
const router = useRouter()
const { processes, connected, killProcess, cleanup } = useProcesses()

const projectFilter = computed({
  get: () => (route.query.project as string) || '',
  set: (val) => router.replace({ query: val ? { project: val } : {} }),
})

const selected = computed(() => {
  const { project, name } = route.params
  if (project && name) {
    return { project: project as string, name: name as string }
  }
  return null
})

const filteredProcesses = computed(() =>
  projectFilter.value
    ? processes.value.filter(p => p.project === projectFilter.value)
    : processes.value,
)

function onSelect(project: string, name: string) {
  router.push({ name: 'process', params: { project, name } })
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
