import { watch, onUnmounted, type Ref } from 'vue'
import { API_BASE } from '@/api'
import { useAnsiRenderer } from './useAnsiRenderer'

export function useLogStream(
  selected: Ref<{ project: string; name: string } | null>,
  logContent: Ref<{ setContent: (h: string) => void; appendChunk: (h: string) => void; scrollToBottom: () => void } | null>,
  autoScroll: Ref<boolean>,
) {
  const { renderToHtml, resetParser } = useAnsiRenderer()
  let logSSE: EventSource | null = null
  let abortController: AbortController | null = null

  function closeStream() {
    if (logSSE) { logSSE.close(); logSSE = null }
    if (abortController) { abortController.abort(); abortController = null }
  }

  watch(selected, async (sel) => {
    closeStream()
    resetParser()

    if (!sel || !logContent.value) return

    const lc = logContent.value
    lc.setContent('<span style="color:var(--color-secondary)">Loading...</span>')

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

      lc.setContent(renderToHtml(data.content || ''))
      if (autoScroll.value) lc.scrollToBottom()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      lc.setContent('<span style="color:var(--color-dead)">Failed to load logs</span>')
      return
    }

    // Start streaming — parser keeps ANSI state from initial load (no second reset)
    const streamUrl = `${API_BASE}/api/processes/${encodeURIComponent(sel.project)}/${encodeURIComponent(sel.name)}/logs/stream`
    logSSE = new EventSource(streamUrl)

    logSSE.onmessage = (e) => {
      // Guard against stale stream delivering to wrong selection
      if (selected.value?.project !== sel.project || selected.value?.name !== sel.name) {
        logSSE?.close()
        return
      }
      const text = JSON.parse(e.data) as string
      const html = renderToHtml(text)
      logContent.value?.appendChunk(html)
      if (autoScroll.value) logContent.value?.scrollToBottom()
    }

    logSSE.onerror = () => {
      // Stream ended (process died, file gone, connection lost)
    }
  })

  onUnmounted(closeStream)

  return { closeStream }
}
