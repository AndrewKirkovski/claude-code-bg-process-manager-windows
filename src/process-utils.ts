/**
 * Process management utilities: alive checks, command parsing, kill,
 * netstat parsing, parent-PID lookup.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { parse as shellParse } from "shell-quote";
import { basename } from "path";
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

// ── ANSI stripping ──────────────────────────────────────────────

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
             .replace(/\r(?!\n)/g, "");
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
 * Parse a command string into executable + args via shell-quote, extracting
 * leading ENV=VAR assignments. Returns null if the command contains any shell
 * operator ({op: '|'}, {op: '>'}, etc.) or a glob pattern — those cases need
 * a real shell.
 *
 * shell-quote returns a mixed array: plain strings for tokens, and objects
 * ({op} for operators, {pattern} for unexpanded globs, {comment} for #...).
 * Any non-string entry is the "needs shell" signal.
 */
export function parseSimpleCommand(command: string): {
  envVars: Record<string, string>;
  executable: string;
  args: string[];
} | null {
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(command);
  } catch {
    return null;
  }

  if (parsed.length === 0) return null;

  const tokens: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") return null; // operator/glob/comment → shell
    tokens.push(entry);
  }

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

/**
 * Detect whether a command's first executable is a Python interpreter.
 * Used to set PYTHONUTF8=1 + PYTHONIOENCODING=utf-8 defaults so child
 * Python processes don't crash on cp1252 Windows consoles.
 *
 * Uses shell-quote tokenisation so quoted paths ("C:\Program Files\python.exe")
 * are handled correctly. For commands that need a shell (pipes, etc.), we
 * scan the first non-env token instead.
 */
export function commandRunsPython(command: string): boolean {
  let parsed: ReturnType<typeof shellParse>;
  try {
    parsed = shellParse(command);
  } catch {
    return false;
  }

  for (const entry of parsed) {
    if (typeof entry !== "string") return false; // first operator reached — stop
    // skip leading ENV=VAR assignments
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) continue;
    const exe = basename(entry).toLowerCase().replace(/\.exe$/, "");
    return exe === "python" || exe === "python3" || exe === "py";
  }
  return false;
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
  throw new Error(
    "Git Bash not found. bg-manager requires Git for Windows to run commands that use shell features (pipes, &&, redirects). " +
    "Install it from https://git-scm.com/downloads/win and restart your editor."
  );
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
