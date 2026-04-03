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
