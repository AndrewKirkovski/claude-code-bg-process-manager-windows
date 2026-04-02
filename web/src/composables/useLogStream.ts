import { watch, onUnmounted, type Ref } from 'vue'
import { API_BASE } from '@/api'

export function useLogStream(
  selected: Ref<{ project: string; name: string } | null>,
  logContent: Ref<{ write: (data: string) => void; clear: () => void; scrollToBottom: () => void } | null>,
  autoScroll: Ref<boolean>,
) {
  let logSSE: EventSource | null = null
  let abortController: AbortController | null = null

  function closeStream() {
    if (logSSE) { logSSE.close(); logSSE = null }
    if (abortController) { abortController.abort(); abortController = null }
  }

  watch(selected, async (sel) => {
    closeStream()

    if (!sel || !logContent.value) return

    const lc = logContent.value
    lc.clear()

    // Abort-safe fetch for initial logs
    abortController = new AbortController()
    const { signal } = abortController

    try {
      const url = `${API_BASE}/api/processes/${encodeURIComponent(sel.project)}/${encodeURIComponent(sel.name)}/logs?lines=500`
      const res = await fetch(url, { signal })
      if (signal.aborted) return
      const data = await res.json()

      // Verify selection hasn't changed during fetch
      if (selected.value?.project !== sel.project || selected.value?.name !== sel.name) return

      lc.write(data.content || '')
      if (autoScroll.value) lc.scrollToBottom()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      lc.write('\x1b[31mFailed to load logs\x1b[0m\r\n')
      return
    }

    // Start streaming
    const streamUrl = `${API_BASE}/api/processes/${encodeURIComponent(sel.project)}/${encodeURIComponent(sel.name)}/logs/stream`
    logSSE = new EventSource(streamUrl)

    logSSE.onmessage = (e) => {
      if (selected.value?.project !== sel.project || selected.value?.name !== sel.name) {
        logSSE?.close()
        return
      }
      let text: string
      try { text = JSON.parse(e.data) } catch { return }
      logContent.value?.write(text)
      if (autoScroll.value) logContent.value?.scrollToBottom()
    }

    logSSE.onerror = () => {
      // Stream ended (process died, file gone, connection lost)
    }
  })

  onUnmounted(closeStream)

  return { closeStream }
}
