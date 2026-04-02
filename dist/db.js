/**
 * SQLite database layer for bg-manager.
 * DB lives at ~/.bg-manager/bg-manager.db (WAL mode).
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isAlive } from "./process-utils.js";
// ── Paths ────────────────────────────────────────────────────────
export const BG_MANAGER_HOME = join(homedir(), ".bg-manager");
export const DB_PATH = join(BG_MANAGER_HOME, "bg-manager.db");
export const LOGS_DIR = join(BG_MANAGER_HOME, "logs");
// ── Project helpers ──────────────────────────────────────────────
/** Normalise a project path for consistent storage and lookup. */
export function normalizeProject(cwd) {
    return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
/** Short slug from a project path for log file naming. */
export function projectSlug(project) {
    const parts = project.split("/").filter(Boolean);
    const relevant = parts.slice(-2).join("-");
    return relevant.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}
// ── Singleton DB ─────────────────────────────────────────────────
let db = null;
export function getDb() {
    if (!db)
        throw new Error("Database not initialised — call ensureDb() first");
    return db;
}
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
export function ensureDb() {
    if (db)
        return;
    if (!existsSync(BG_MANAGER_HOME))
        mkdirSync(BG_MANAGER_HOME, { recursive: true });
    if (!existsSync(LOGS_DIR))
        mkdirSync(LOGS_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
    CREATE TABLE IF NOT EXISTS processes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      project     TEXT    NOT NULL,
      pid         INTEGER NOT NULL,
      command     TEXT    NOT NULL,
      intent      TEXT    NOT NULL,
      log_file    TEXT    NOT NULL,
      started_at  TEXT    NOT NULL,
      cwd         TEXT    NOT NULL,
      UNIQUE(project, name)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
    // Schema version tracking
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) {
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    }
}
// ── CRUD ─────────────────────────────────────────────────────────
export function addProcess(entry) {
    getDb().prepare(`
    INSERT OR REPLACE INTO processes (name, project, pid, command, intent, log_file, started_at, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.name, entry.project, entry.pid, entry.command, entry.intent, entry.log_file, entry.started_at, entry.cwd);
}
export function removeProcess(project, name) {
    getDb().prepare("DELETE FROM processes WHERE project = ? AND name = ?").run(project, name);
}
export function getProcess(project, name) {
    return getDb().prepare("SELECT * FROM processes WHERE project = ? AND name = ?").get(project, name);
}
export function getProjectProcesses(project) {
    return getDb().prepare("SELECT * FROM processes WHERE project = ? ORDER BY started_at DESC").all(project);
}
export function getAllProcesses() {
    return getDb().prepare("SELECT * FROM processes ORDER BY project, started_at DESC").all();
}
/** Enrich rows with live alive status. */
export function withStatus(rows) {
    return rows.map(r => ({ ...r, alive: isAlive(r.pid) }));
}
export function cleanupDead(project) {
    const rows = getProjectProcesses(project);
    const dead = [];
    let aliveCount = 0;
    for (const r of rows) {
        if (isAlive(r.pid)) {
            aliveCount++;
        }
        else {
            dead.push(r);
        }
    }
    if (dead.length > 0) {
        const d = getDb();
        const stmt = d.prepare("DELETE FROM processes WHERE project = ? AND name = ?");
        const tx = d.transaction(() => {
            for (const r of dead)
                stmt.run(r.project, r.name);
        });
        tx();
    }
    return { removed: dead, aliveCount };
}
export function cleanupAllDead() {
    const rows = getAllProcesses();
    const dead = [];
    let aliveCount = 0;
    for (const r of rows) {
        if (isAlive(r.pid)) {
            aliveCount++;
        }
        else {
            dead.push(r);
        }
    }
    if (dead.length > 0) {
        const d = getDb();
        const stmt = d.prepare("DELETE FROM processes WHERE id = ?");
        const tx = d.transaction(() => {
            for (const r of dead)
                stmt.run(r.id);
        });
        tx();
    }
    return { removed: dead, aliveCount };
}
//# sourceMappingURL=db.js.map