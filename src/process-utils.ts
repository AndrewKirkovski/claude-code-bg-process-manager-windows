/**
 * Process management utilities: alive checks, command parsing, kill,
 * netstat parsing, parent-PID lookup.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import type { ProcessRow } from "./types.js";

// ── PID helpers ──────────────────────────────────────────────────

export function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 4194304;
}

export function isAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we lack permission — still alive
    return e.code === 'EPERM';
  }
}

// ── Name sanitisation ────────────────────────────────────────────

export function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  if (!sanitized || !/[a-zA-Z0-9]/.test(sanitized)) {
    return "unnamed_process";
  }
  return sanitized;
}

// ── Command parsing ──────────────────────────────────────────────

/**
 * Returns true if the command contains unquoted shell metacharacters
 * and therefore needs `bash -c` wrapping.
 */
export function needsShell(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && "|&;<>`$()".includes(ch)) return true;
  }
  return false;
}

/**
 * Parse a simple command into executable + args, extracting leading ENV=VAR.
 * Returns null if the command needs a shell.
 */
export function parseSimpleCommand(command: string): {
  envVars: Record<string, string>;
  executable: string;
  args: string[];
} | null {
  if (needsShell(command)) return null;

  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) return null;

  const envVars: Record<string, string> = {};
  let startIdx = 0;
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      envVars[match[1]] = match[2];
      startIdx = i + 1;
    } else {
      break;
    }
  }

  if (startIdx >= tokens.length) return null;

  return {
    envVars,
    executable: tokens[startIdx],
    args: tokens.slice(startIdx + 1),
  };
}

// ── Shell path detection ─────────────────────────────────────────

export function findBashPath(): string {
  if (process.platform !== "win32") return "bash";
  const gitBashPaths = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const p of gitBashPaths) {
    if (existsSync(p)) return p;
  }
  return "bash";
}

// ── Parent PID lookup ────────────────────────────────────────────

export function getParentPid(pid: number): number | null {
  if (!isValidPid(pid)) return null;
  if (process.platform === "win32") {
    try {
      const out = execSync(
        `powershell -NoProfile -c "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).ParentProcessId"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const ppid = parseInt(out, 10);
      return isNaN(ppid) || ppid === 0 || ppid === pid ? null : ppid;
    } catch { return null; }
  }
  return null;
}

/**
 * Walk up the parent chain to find a tracked process entry.
 * Handles the bash-wrapper case where a port shows a child PID
 * but the tracked entry is the parent bash PID.
 */
export function findTrackedEntry(pid: number, entries: ProcessRow[]): ProcessRow | undefined {
  let currentPid: number | null = pid;
  for (let depth = 0; depth < 5 && currentPid !== null; depth++) {
    const tracked = entries.find(e => e.pid === currentPid);
    if (tracked) return tracked;
    currentPid = getParentPid(currentPid);
  }
  return undefined;
}

// ── Netstat parsing ──────────────────────────────────────────────

export function parseNetstat(output: string, port: number): Array<{ pid: number; state: string }> {
  const results: Array<{ pid: number; state: string }> = [];
  const seen = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    const portMatch = parts[1].match(/:(\d+)$/);
    if (!portMatch || parseInt(portMatch[1], 10) !== port) continue;
    const state = parts[3];
    const pid = parseInt(parts[4], 10);
    if (isNaN(pid) || pid === 0 || seen.has(pid)) continue;
    seen.add(pid);
    results.push({ pid, state });
  }
  return results;
}

// ── Process killing ──────────────────────────────────────────────

/**
 * Kill a process tree. On Windows uses PowerShell recursive tree kill.
 * On Linux uses process group kill.
 */
export function killProcessTree(pid: number): void {
  if (!isValidPid(pid)) return;
  try {
    if (process.platform === "win32") {
      const ps = `function KillTree($id){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -EA SilentlyContinue | ForEach-Object { KillTree $_.ProcessId }; Stop-Process -Id $id -Force -EA SilentlyContinue } KillTree ${pid}`;
      execSync(`powershell -NoProfile -c "${ps}"`, { stdio: "ignore", timeout: 10000 });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
}
