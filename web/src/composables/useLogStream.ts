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

  // Load the full log history, then follow it live. Shared by the selection
  // watcher and reload() (called after a restart to re-read the fresh log).
  async function start(sel: { project: string; name: string }) {
    closeStream()

    if (!logContent.value) return

    const lc = logContent.value
    lc.clear()

    // Abort-safe fetch for initial logs
    abortController = new AbortController()
    const { signal } = abortController

    try {
      // full=1: load the entire log (no tail truncation) — xterm virtualizes rendering.
      const url = `${API_BASE}/api/processes/${encodeURIComponent(sel.project)}/${encodeURIComponent(sel.name)}/logs?full=1`
      const res = await fetch(url, { signal })
      if (signal.aborted) return
      if (!res.ok) { lc.write('\x1b[31mFailed to load logs\x1b[0m\r\n'); return }
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
  }

  // Watch both: on direct URL navigation, selected is set before logContent mounts
  watch([selected, logContent], ([sel]) => {
    if (!sel || !logContent.value) { closeStream(); return }
    void start(sel)
  })

  /** Clear and re-read the current process's log (e.g. after a restart). */
  function reload() {
    const sel = selected.value
    if (!sel) return
    void start(sel)
  }

  onUnmounted(closeStream)

  return { closeStream, reload }
}
