#!/usr/bin/env node
/**
 * bg-manager — MCP server for background process management.
 *
 * v2: SQLite database at ~/.bg-manager/, web UI dashboard, ANSI color capture.
 *
 * Tools:
 *   bg_run(name, command, intent)  — spawn a background process with auto-logging
 *   bg_list()                       — list all tracked processes with status
 *   bg_kill(name)                   — kill a tracked process by name
 *   bg_logs(name, lines?, raw?, filter?) — read last N lines from a process log
 *   bg_port_check(port)             — check what's listening on a port
 *   bg_port_kill(port)              — kill whatever is listening on a port
 *   bg_cleanup()                    — remove dead entries from registry
 */
export declare function getHttpPort(): number | null;
