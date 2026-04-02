/**
 * MCP tool implementations: bg_run, bg_list, bg_kill, bg_logs,
 * bg_port_check, bg_port_kill, bg_cleanup.
 *
 * All functions return a plain string (displayed to Claude).
 * Tool signatures and output format are identical to v1.
 */
export declare function setProjectRoot(root: string): void;
export declare function bgRun(name: string, command: string, intent: string): string;
export declare function bgList(): string;
export declare function bgKill(name: string): string;
export declare function bgLogs(name: string, lines?: number, raw?: boolean, filter?: string | string[]): string;
export declare function bgPortCheck(port: number): string;
export declare function bgPortKill(port: number): string;
export declare function bgCleanup(): string;
