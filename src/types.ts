/**
 * Shared type definitions for bg-manager.
 */

/** Row as stored in the SQLite `processes` table. */
export interface ProcessRow {
  id: number;
  name: string;
  project: string;
  pid: number;
  command: string;
  intent: string;
  log_file: string;
  started_at: string;
  cwd: string;
  env_vars: string | null;  // JSON-encoded user-provided extras, null when not set
  exit_code: number | null; // null while alive or if exit code unknown
  mode: "bg" | "sync";      // 'bg' = bg_run, 'sync' = sync_run (may convert to bg on timeout)
}

/** ProcessRow enriched with live status. */
export interface ProcessWithStatus extends ProcessRow {
  alive: boolean;
}

// ── Trigger types ───────────────────────────────────────────────

export interface LogTriggerEntry {
  pattern: string;
  once?: boolean;  // default false — fire every match
}

export interface TriggerConfig {
  notifyDead?: boolean;       // default true
  notifyPort?: boolean;       // detect localhost:PORT patterns
  notifyReady?: boolean;      // detect "ready"/"listening"/"started" patterns
  logTriggers?: LogTriggerEntry[];
}

export interface TriggerState {
  config: TriggerConfig;
  firedDead: boolean;
  firedReady: boolean;
  firedPorts: Set<string>;
  firedLogOnce: Set<string>;  // pattern sources that fired (for once: true)
}
