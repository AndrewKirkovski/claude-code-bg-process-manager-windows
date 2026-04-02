import { ref, onMounted, onUnmounted } from 'vue'
import { API_BASE } from '@/api'
import type { ProcessWithStatus } from '@/types'

export function useProcesses() {
  const processes = ref<ProcessWithStatus[]>([])
  const connected = ref(false)
  let sse: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (sse) sse.close()
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    sse = new EventSource(`${API_BASE}/api/sse`)

    sse.addEventListener('process_list', (e) => {
      try { processes.value = JSON.parse((e as MessageEvent).data) } catch { /* malformed SSE */ }
    })

    sse.onopen = () => { connected.value = true }

    sse.onerror = () => {
      connected.value = false
      // Reconnect if permanently closed
      if (sse && sse.readyState === EventSource.CLOSED) {
        sse.close()
        sse = null
        reconnectTimer = setTimeout(connect, 3000)
      }
    }
  }

  async function killProcess(project: string, name: string) {
    try {
      await fetch(
        `${API_BASE}/api/processes/${encodeURIComponent(project)}/${encodeURIComponent(name)}/kill`,
        { method: 'POST' },
      )
    } catch { /* server may be down */ }
  }

  async function cleanup() {
    try {
      await fetch(`${API_BASE}/api/cleanup`, { method: 'POST' })
    } catch { /* server may be down */ }
  }

  onMounted(connect)
  onUnmounted(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    sse?.close()
    sse = null
  })

  return { processes, connected, killProcess, cleanup }
}
