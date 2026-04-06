/**
 * One-time migration: import processes from per-project .local/bg-processes.json
 * into the central SQLite database, and copy log files.
 */

import { existsSync, readFileSync, renameSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { addProcess, getProcess, normalizeProject, projectSlug, LOGS_DIR } from "./db.js";

interface LegacyEntry {
  name: string;
  pid: number;
  command: string;
  intent: string;
  logFile: string;
  startedAt: string;
  cwd: string;
}

export function migrateFromJson(projectRoot: string): void {
  const jsonPath = join(projectRoot, ".local", "bg-processes.json");
  if (!existsSync(jsonPath)) return;

  let entries: LegacyEntry[];
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
    entries = Array.isArray(data) ? data : [];
  } catch {
    return; // Corrupt file — skip
  }

  if (entries.length === 0) {
    // Empty registry — just rename
    try { renameSync(jsonPath, jsonPath + ".migrated"); } catch {}
    return;
  }

  const project = normalizeProject(projectRoot);
  const slug = projectSlug(project);

  for (const e of entries) {
    // Skip if already migrated
    if (getProcess(project, e.name)) continue;

    // Determine new log path
    const newLogFile = join(LOGS_DIR, `${slug}-${e.name}.log`);

    // Copy log file if it exists
    if (e.logFile && existsSync(e.logFile)) {
      try {
        const logDir = dirname(newLogFile);
        if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
        copyFileSync(e.logFile, newLogFile);
      } catch {
        // Non-fatal — process entry still imported with new path
      }
    }

    addProcess({
      name: e.name,
      project,
      pid: e.pid,
      command: e.command,
      intent: e.intent,
      log_file: newLogFile,
      started_at: e.startedAt,
      cwd: e.cwd,
      env_vars: null,
      exit_code: null,
    });
  }

  // Mark as migrated
  try { renameSync(jsonPath, jsonPath + ".migrated"); } catch {}
}
