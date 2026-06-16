// Small shared helpers for the dashboard UI.

/** Strip ANSI escape sequences (mirror of src/process-utils.ts stripAnsi). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\r(?!\n)/g, '')
}

/**
 * Copy text to the clipboard. Prefers the async Clipboard API (available because
 * 127.0.0.1 is a secure context), falling back to a hidden textarea + execCommand
 * for older browsers. Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to legacy path */ }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    // execCommand is deprecated but remains the only sync clipboard fallback for
    // browsers without the async Clipboard API. Cast to a minimal non-deprecated
    // signature so this intentional legacy path doesn't trip the deprecation hint.
    const ok = (document as unknown as { execCommand(c: string): boolean }).execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
