// Shared derivation of a process's display details, consumed by both the
// ProcessEntry hover tooltip (renders HTML) and the LogViewer "Copy details"
// button (renders plaintext). Keeps the field list, env parsing and trigger
// summary in one place instead of duplicated per component.

import type { ProcessWithStatus } from './types'

export interface DetailRow {
  label: string
  value: string
}

/** Plain status word: "ALIVE" or "COMPLETED (exit N)". */
export function statusText(p: ProcessWithStatus): string {
  if (p.alive) return 'ALIVE'
  return `COMPLETED${p.exit_code !== null ? ` (exit ${p.exit_code})` : ''}`
}

/** Parse env_vars JSON into entries, returning [] for absent or malformed values. */
export function parseEnv(p: ProcessWithStatus): [string, string][] {
  if (!p.env_vars) return []
  try {
    return Object.entries(JSON.parse(p.env_vars) as Record<string, string>)
  } catch {
    return []
  }
}

/** Human-readable summary of active triggers, or null when none are configured. */
export function triggerSummary(p: ProcessWithStatus): string | null {
  const t = p.triggers
  if (!t) return null
  const parts: string[] = []
  if (t.config.notifyDead !== false) parts.push('death')
  if (t.config.notifyPort) parts.push('port')
  if (t.config.notifyReady) parts.push('ready')
  const pc = t.config.logTriggers?.length ?? 0
  if (pc > 0) parts.push(`${pc} log pattern${pc > 1 ? 's' : ''}`)
  return parts.length ? parts.join(', ') : null
}

/** Ordered label/value rows for a process (Env and Triggers included only when present). */
export function detailRows(p: ProcessWithStatus): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'PID', value: String(p.pid) },
    { label: 'Command', value: p.command },
    { label: 'Intent', value: p.intent },
    { label: 'CWD', value: p.cwd },
    { label: 'Started', value: p.started_at },
    { label: 'Log', value: p.log_file },
  ]
  const env = parseEnv(p)
  if (env.length) rows.push({ label: 'Env', value: env.map(([k, v]) => `${k}=${v}`).join(', ') })
  const trig = triggerSummary(p)
  if (trig) rows.push({ label: 'Triggers', value: trig })
  return rows
}
