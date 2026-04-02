/**
 * Process management utilities: alive checks, command parsing, kill,
 * netstat parsing, parent-PID lookup.
 */
import type { ProcessRow } from "./types.js";
export declare function isValidPid(pid: number): boolean;
export declare function isAlive(pid: number): boolean;
export declare function sanitizeName(name: string): string;
/**
 * Returns true if the command contains unquoted shell metacharacters
 * and therefore needs `bash -c` wrapping.
 */
export declare function needsShell(command: string): boolean;
/**
 * Parse a simple command into executable + args, extracting leading ENV=VAR.
 * Returns null if the command needs a shell.
 */
export declare function parseSimpleCommand(command: string): {
    envVars: Record<string, string>;
    executable: string;
    args: string[];
} | null;
export declare function findBashPath(): string;
export declare function getParentPid(pid: number): number | null;
/**
 * Walk up the parent chain to find a tracked process entry.
 * Handles the bash-wrapper case where a port shows a child PID
 * but the tracked entry is the parent bash PID.
 */
export declare function findTrackedEntry(pid: number, entries: ProcessRow[]): ProcessRow | undefined;
export declare function parseNetstat(output: string, port: number): Array<{
    pid: number;
    state: string;
}>;
/**
 * Kill a process tree. On Windows uses PowerShell recursive tree kill.
 * On Linux uses process group kill.
 */
export declare function killProcessTree(pid: number): void;
