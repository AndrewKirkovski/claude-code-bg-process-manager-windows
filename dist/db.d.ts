/**
 * SQLite database layer for bg-manager.
 * DB lives at ~/.bg-manager/bg-manager.db (WAL mode).
 */
import Database from "better-sqlite3";
import type { ProcessRow, ProcessWithStatus } from "./types.js";
export declare const BG_MANAGER_HOME: string;
export declare const DB_PATH: string;
export declare const LOGS_DIR: string;
/** Normalise a project path for consistent storage and lookup. */
export declare function normalizeProject(cwd: string): string;
/** Short slug from a project path for log file naming. */
export declare function projectSlug(project: string): string;
export declare function getDb(): Database.Database;
export declare function closeDb(): void;
export declare function ensureDb(): void;
export declare function addProcess(entry: Omit<ProcessRow, "id">): void;
export declare function removeProcess(project: string, name: string): void;
export declare function getProcess(project: string, name: string): ProcessRow | undefined;
export declare function getProjectProcesses(project: string): ProcessRow[];
export declare function getAllProcesses(): ProcessRow[];
/** Enrich rows with live alive status. */
export declare function withStatus(rows: ProcessRow[]): ProcessWithStatus[];
export declare function cleanupDead(project: string): {
    removed: ProcessRow[];
    aliveCount: number;
};
export declare function cleanupAllDead(): {
    removed: ProcessRow[];
    aliveCount: number;
};
