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
