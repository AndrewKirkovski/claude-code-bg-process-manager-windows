/**
 * One-time migration: import processes from per-project .local/bg-processes.json
 * into the central SQLite database, and copy log files.
 */
export declare function migrateFromJson(projectRoot: string): void;
