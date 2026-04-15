/**
 * MCP tool implementations: bg_run, sync_run, bg_list, bg_kill, read_log,
 * bg_port_check, bg_port_kill, bg_cleanup.
 *
 * All functions return a plain string (displayed to Claude).
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, createWriteStream } from "fs";
import { join, isAbsolute } from "path";
import * as nodePty from "node-pty";
import {
  isAlive, sanitizeName, parseSimpleCommand, findBashPath,
  parseNetstat, findTrackedEntry, killProcessTree, stripAnsi,
  commandRunsPython,
} from "./process-utils.js";
import {
  addProcess, removeProcess, getProcess, getProjectProcesses,
  getAllProcesses, cleanupDead, normalizeProject, projectSlug, setExitCode, LOGS_DIR,
} from "./db.js";
import { registerTriggers, unregisterTriggers } from "./trigger-monitor.js";
import type { TriggerConfig } from "./types.js";

// Current project context (set once at startup)
let PROJECT_ROOT = process.cwd();
let PROJECT = normalizeProject(PROJECT_ROOT);

export function setProjectRoot(root: string): void {
  PROJECT_ROOT = root;
  PROJECT = normalizeProject(root);
}


// Format optional CWD/env notes for bg_run output
function formatRunNotes(cwd: string, envKeys: string[]): string {
  const cwdNote = cwd !== PROJECT_ROOT ? `\n  CWD: ${cwd}` : "";
  const envNote = envKeys.length > 0 ? `\n  Env: ${envKeys.join(", ")}` : "";
  return `${cwdNote}${envNote}`;
}

// ── Spawn helper (shared by bg_run and sync_run) ─────────────────

type SpawnMode = "direct" | "shell" | "pty";

interface SpawnedProcess {
  pid: number;
  spawnMode: SpawnMode;
  logFile: string;
  effectiveCwd: string;
  envKeys: string[];
  /** Resolves with exit code when the child exits (null = unknown). */
  onExit: Promise<number | null>;
  /** Release our reference so Node doesn't wait for this child on shutdown. */
  detach: () => void;
  /** Kill the process tree. */
  kill: () => void;
}

/**
 * Validates args, resolves spawn mode (direct / shell / pty), opens the log
 * file, spawns the child, and wires up the exit-code capture. Caller decides
 * whether to unref() (background) or await onExit (sync).
 *
 * Throws Error on validation / spawn failure — caller formats the message.
 */
function spawnProcess(
  name: string, command: string,
  workingDir: string | undefined,
  env: Record<string, string> | undefined,
): SpawnedProcess {
  // Validate working_dir
  if (workingDir) {
    if (!isAbsolute(workingDir)) {
      throw new Error(`working_dir must be an absolute path, got "${workingDir}".`);
    }
    try {
      if (!statSync(workingDir).isDirectory()) {
        throw new Error(`working_dir "${workingDir}" is not a directory.`);
      }
    } catch (e: any) {
      if (e.message?.startsWith("working_dir")) throw e;
      throw new Error(`working_dir "${workingDir}" does not exist.`);
    }
  }

  const effectiveCwd = workingDir || PROJECT_ROOT;
  const envKeys = env ? Object.keys(env) : [];

  const slug = projectSlug(PROJECT);
  const logFile = join(LOGS_DIR, `${slug}-${name}.log`);

  // Base env: inherit parent, set always-on defaults, optionally add PYTHONUTF8
  // if the command looks like it runs Python, then let user env override.
  const baseDefaults: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    FORCE_COLOR: "1",
  };
  if (commandRunsPython(command)) {
    baseDefaults.PYTHONUTF8 = "1";
  }
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    ...baseDefaults,
    ...(env ?? {}),
  };

  // HACK: wippy.exe needs a real TTY to emit ANSI colors.
  // node-pty provides a ConPTY so the Go binary sees isatty()=true.
  const needsPty = /(?:^|[\\/\s])wippy(?:\.exe)?(?:\s|$)/.test(command);

  if (needsPty) {
    const shellPath = findBashPath();
    const ptyProcess = nodePty.spawn(shellPath, ["-c", command], {
      name: "xterm-256color",
      cols: 10000,
      rows: 50,
      cwd: effectiveCwd,
      env: spawnEnv as Record<string, string>,
    });

    const logStream = createWriteStream(logFile, { flags: "w" });
    ptyProcess.onData((data: string) => { logStream.write(data); });

    const onExit = new Promise<number | null>((resolve) => {
      ptyProcess.onExit(({ exitCode }) => {
        logStream.end();
        try { setExitCode(PROJECT, name, exitCode); } catch { /* removed */ }
        resolve(exitCode ?? null);
      });
    });

    return {
      pid: ptyProcess.pid,
      spawnMode: "pty",
      logFile,
      effectiveCwd,
      envKeys,
      onExit,
      // node-pty has no unref() — the pty process is detached by the library itself.
      detach: () => { /* no-op */ },
      kill: () => { try { ptyProcess.kill(); } catch { /* already dead */ } },
    };
  }

  // Non-PTY: spawn directly if the command is simple, fall back to shell.
  let child: ChildProcess;
  let spawnMode: SpawnMode;

  const logFd = openSync(logFile, "w");
  try {
    const parsed = parseSimpleCommand(command);

    if (parsed) {
      spawnMode = "direct";
      child = spawn(parsed.executable, parsed.args, {
        cwd: effectiveCwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: process.platform === "win32",
        env: { ...spawnEnv, ...parsed.envVars },
      });
      child.on("error", () => {}); // prevent unhandled 'error' crash

      // Direct spawn fails for .cmd/.ps1 shims (pnpm, npx, etc.) on Windows.
      // Fall back to shell mode so the command still runs.
      if (!child.pid) {
        spawnMode = "shell";
        const shellPath = findBashPath();
        child = spawn(shellPath, ["-c", command], {
          cwd: effectiveCwd,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: process.platform === "win32",
          env: spawnEnv,
        });
        child.on("error", () => {});
      }
    } else {
      spawnMode = "shell";
      const shellPath = findBashPath();
      child = spawn(shellPath, ["-c", command], {
        cwd: effectiveCwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: process.platform === "win32",
        env: spawnEnv,
      });
      child.on("error", () => {});
    }
  } finally {
    closeSync(logFd);
  }

  if (!child.pid) {
    throw new Error("process failed to start (no PID returned)");
  }

  const childPid = child.pid;
  const onExit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      try { setExitCode(PROJECT, name, code ?? null); } catch { /* removed */ }
      resolve(code ?? null);
    });
  });

  const childRef = child;
  return {
    pid: childPid,
    spawnMode,
    logFile,
    effectiveCwd,
    envKeys,
    onExit,
    detach: () => { try { childRef.unref(); } catch { /* already detached */ } },
    kill: () => { try { killProcessTree(childPid); } catch { /* already dead */ } },
  };
}

function formatSpawnModeTag(mode: SpawnMode): string {
  if (mode === "direct") return "direct";
  if (mode === "shell") return "via shell";
  return "via pty";
}

// ── bg_run ───────────────────────────────────────────────────────

export function bgRun(
  name: string, command: string, intent: string,
  triggers?: TriggerConfig,
  workingDir?: string,
  env?: Record<string, string>,
): string {
  name = sanitizeName(name);

  // Check if name already in use
  const existing = getProcess(PROJECT, name);
  if (existing && isAlive(existing.pid)) {
    return `Error: process "${name}" is already running (PID ${existing.pid}). Kill it first with bg_kill.`;
  }

  const envVarsJson = env && Object.keys(env).length > 0 ? JSON.stringify(env) : null;

  let spawned: SpawnedProcess;
  try {
    spawned = spawnProcess(name, command, workingDir, env);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }

  // Detach — background process outlives the MCP server
  spawned.detach();

  addProcess({
    name,
    project: PROJECT,
    pid: spawned.pid,
    command,
    intent,
    log_file: spawned.logFile,
    started_at: new Date().toISOString(),
    cwd: spawned.effectiveCwd,
    env_vars: envVarsJson,
    exit_code: null,
    mode: "bg",
  });

  if (triggers) registerTriggers(PROJECT, name, spawned.pid, spawned.logFile, triggers);

  const modeTag = formatSpawnModeTag(spawned.spawnMode);
  return `Started "${name}" (PID ${spawned.pid}, ${modeTag})\n  Command: ${command}\n  Intent: ${intent}${formatRunNotes(spawned.effectiveCwd, spawned.envKeys)}\n  Log: ${spawned.logFile}`;
}

// ── sync_run ─────────────────────────────────────────────────────

// ── Shared log reader (read_log + sync_run) ───────────────────────

interface ReadLogOpts {
  /** Last N lines to keep after filter (default 50, max 1000). */
  lines?: number;
  /** If true, preserve ANSI color codes. Default false (strip). */
  raw?: boolean;
  /** Filter pattern(s). Substring match by default — switch to regex with filterRegex=true. */
  filter?: string | string[];
  /** If true, treat `filter` entries as regex patterns instead of substrings. Case-insensitive. */
  filterRegex?: boolean;
  /** Max bytes to read from disk (default 64KB). Oversized logs are tail-truncated. */
  maxBytes?: number;
}

interface ReadLogResult {
  /** Final text (lines joined), possibly stripped and filtered. */
  content: string;
  /** Total file size on disk (bytes). */
  totalSize: number;
  /** True if the file was larger than maxBytes (we only read the tail). */
  truncatedRead: boolean;
  /** How many lines matched the filter before the `lines` cap was applied. */
  matchedLines: number;
  /** How many lines are in `content` (after the `lines` cap). */
  returnedLines: number;
  /** Set when filter regex compilation failed — caller should return this as an error. */
  regexError?: string;
}

/**
 * Read a log file tail, apply optional substring filter, cap to last N lines,
 * optionally strip ANSI. Shared between `read_log` and `sync_run` so both tools
 * expose the same filtering semantics.
 *
 * Read order:
 *   1. Read last `maxBytes` bytes from disk, trimmed to a line boundary.
 *   2. Split into lines.
 *   3. If filter is set, drop non-matching lines (matched against ANSI-stripped text).
 *   4. Take the last `lines` entries.
 *   5. If not raw, strip ANSI from the final output.
 */
function readLogFiltered(logFile: string, opts: ReadLogOpts = {}): ReadLogResult {
  const lines = Math.max(1, Math.min(1000, opts.lines ?? 50));
  const raw = opts.raw ?? false;
  const maxBytes = Math.max(1024, Math.min(1024 * 1024, opts.maxBytes ?? 65536));

  if (!existsSync(logFile)) {
    return { content: "", totalSize: 0, truncatedRead: false, matchedLines: 0, returnedLines: 0 };
  }

  const stat = statSync(logFile);
  let content: string;
  let truncatedRead = false;
  if (stat.size > maxBytes) {
    truncatedRead = true;
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      content = buf.toString("utf-8");
      const firstNewline = content.indexOf("\n");
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
    } finally {
      closeSync(fd);
    }
  } else {
    content = readFileSync(logFile, "utf-8");
  }

  let allLines = content.split("\n");

  // Apply filter — match against stripped text so ANSI codes don't interfere.
  // Default = case-insensitive substring. With filterRegex=true each entry is a regex.
  if (opts.filter) {
    const patterns = (Array.isArray(opts.filter) ? opts.filter : [opts.filter]).filter(p => p.length > 0);
    if (patterns.length > 0) {
      if (opts.filterRegex) {
        const compiled: RegExp[] = [];
        for (const p of patterns) {
          try {
            compiled.push(new RegExp(p, "i"));
          } catch (e: any) {
            return {
              content: "",
              totalSize: stat.size,
              truncatedRead,
              matchedLines: 0,
              returnedLines: 0,
              regexError: `Invalid regex "${p}": ${e.message}`,
            };
          }
        }
        allLines = allLines.filter(line => {
          const plain = stripAnsi(line);
          return compiled.some(re => re.test(plain));
        });
      } else {
        const lowerPatterns = patterns.map(p => p.toLowerCase());
        allLines = allLines.filter(line => {
          const plain = stripAnsi(line).toLowerCase();
          return lowerPatterns.some(p => plain.includes(p));
        });
      }
    }
  }

  const matchedLines = allLines.length;
  const tailLines = allLines.slice(-lines);
  let tail = tailLines.join("\n");
  if (!raw) tail = stripAnsi(tail);

  return {
    content: tail,
    totalSize: stat.size,
    truncatedRead,
    matchedLines,
    returnedLines: tailLines.length,
  };
}

export interface SyncRunOpts {
  /** Seconds before converting to background (default 30, clamped 1-3600). */
  timeoutSec?: number;
  workingDir?: string;
  env?: Record<string, string>;
  /** Last N lines of output to return (default 200, max 1000). */
  lines?: number;
  /** If true, preserve ANSI color codes in returned output (default false). */
  raw?: boolean;
  /** Filter pattern(s) — same semantics as read_log. Default: case-insensitive substring. */
  filter?: string | string[];
  /** If true, treat filter entries as regex patterns (case-insensitive). */
  filterRegex?: boolean;
  /** Max bytes of log tail to read from disk (default 256KB, max 1MB). */
  maxBytes?: number;
}

export async function syncRun(
  name: string, command: string, intent: string,
  opts: SyncRunOpts = {},
): Promise<string> {
  name = sanitizeName(name);
  const timeoutSec = Math.max(1, Math.min(3600, opts.timeoutSec ?? 30));
  const maxBytes = Math.max(1024, Math.min(1024 * 1024, opts.maxBytes ?? 256 * 1024));
  const lines = Math.max(1, Math.min(1000, opts.lines ?? 200));
  const raw = opts.raw ?? false;

  // Check if name already in use
  const existing = getProcess(PROJECT, name);
  if (existing && isAlive(existing.pid)) {
    return `Error: process "${name}" is already running (PID ${existing.pid}). Kill it first with bg_kill.`;
  }

  const envVarsJson = opts.env && Object.keys(opts.env).length > 0 ? JSON.stringify(opts.env) : null;

  let spawned: SpawnedProcess;
  try {
    spawned = spawnProcess(name, command, opts.workingDir, opts.env);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }

  // Register immediately as 'sync' — visible in dashboard while running
  addProcess({
    name,
    project: PROJECT,
    pid: spawned.pid,
    command,
    intent,
    log_file: spawned.logFile,
    started_at: new Date().toISOString(),
    cwd: spawned.effectiveCwd,
    env_vars: envVarsJson,
    exit_code: null,
    mode: "sync",
  });

  const started = Date.now();

  // Race: process exit vs. timeout
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutSec * 1000);
  });
  const exitPromise = spawned.onExit.then((code) => ({ exited: true as const, code }));

  const result = await Promise.race([exitPromise, timeoutPromise]);
  const durationMs = Date.now() - started;
  const modeTag = formatSpawnModeTag(spawned.spawnMode);
  const readOpts: ReadLogOpts = { lines, raw, filter: opts.filter, filterRegex: opts.filterRegex, maxBytes };

  const filterLabel = opts.filter
    ? Array.isArray(opts.filter) ? opts.filter.join(", ") : opts.filter
    : "";
  const filterNote = opts.filter
    ? ` [${opts.filterRegex ? "regex" : "filter"}: ${filterLabel}]`
    : "";

  if (result === "timeout") {
    // Converted to background — process keeps running, stays in registry.
    // Detach so Node won't wait for it on MCP server shutdown.
    spawned.detach();
    // Don't clear the timeout handle — it already fired.
    const tail = readLogFiltered(spawned.logFile, readOpts);
    if (tail.regexError) {
      return `sync_run "${name}" (PID ${spawned.pid}) converted to background after ${timeoutSec}s, but filter regex was invalid: ${tail.regexError}\n  Re-read with read_log name="${name}" and a valid pattern.`;
    }
    const matchNote = opts.filter ? `, ${tail.matchedLines} matched` : "";
    const header =
      `sync_run "${name}" (PID ${spawned.pid}, ${modeTag}) DID NOT FINISH within ${timeoutSec}s — converted to background.\n` +
      `  Command: ${command}\n  Intent: ${intent}${formatRunNotes(spawned.effectiveCwd, spawned.envKeys)}\n` +
      `  Log: ${spawned.logFile}\n` +
      `  Follow with: read_log name="${name}"  |  stop with: bg_kill name="${name}"\n` +
      `  Partial output (${tail.totalSize}B on disk${tail.truncatedRead ? ", tail-truncated" : ""}${matchNote}${filterNote}, last ${tail.returnedLines} lines):\n\n`;
    return header + (tail.content || "(no output yet)");
  }

  // Process exited within timeout window
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const tail = readLogFiltered(spawned.logFile, readOpts);
  if (tail.regexError) {
    return `sync_run "${name}" (PID ${spawned.pid}) completed in ${durationMs}ms with exit ${result.code ?? "unknown"}, but filter regex was invalid: ${tail.regexError}\n  Re-read with read_log name="${name}" and a valid pattern.`;
  }
  const exitStr = result.code !== null ? String(result.code) : "unknown";
  const matchNote = opts.filter ? `, ${tail.matchedLines} matched` : "";
  const sizeNote = tail.truncatedRead ? `, tail-truncated to ${maxBytes}B` : "";
  // Hint the agent about re-filtering when the filter dropped a lot or the tail was truncated.
  // This reminds the LLM the log is persisted and can be re-read without re-running the command.
  const rereadHint =
    (opts.filter && tail.matchedLines > tail.returnedLines) || tail.truncatedRead
      ? `\n  Re-filter without re-running: read_log name="${name}" filter="..." lines=... (log is persisted)`
      : `\n  Re-read with different filter: read_log name="${name}" filter="..." (log is persisted at path above)`;
  const header =
    `sync_run "${name}" (PID ${spawned.pid}, ${modeTag}) completed in ${durationMs}ms, exit ${exitStr}.\n` +
    `  Command: ${command}\n  Intent: ${intent}${formatRunNotes(spawned.effectiveCwd, spawned.envKeys)}\n` +
    `  Log: ${spawned.logFile}${rereadHint}\n` +
    `  Output (${tail.totalSize}B on disk${sizeNote}${matchNote}${filterNote}, last ${tail.returnedLines} lines):\n\n`;
  return header + (tail.content || "(no output)");
}

// ── bg_list ──────────────────────────────────────────────────────

export function bgList(): string {
  const rows = getProjectProcesses(PROJECT);
  if (rows.length === 0) return "No tracked processes.";

  const lines: string[] = [];
  for (const entry of rows) {
    const alive = isAlive(entry.pid);
    const exitStr = !alive && entry.exit_code !== null ? ` (exit ${entry.exit_code})` : "";
    const status = alive ? "ALIVE" : `DEAD${exitStr}`;
    const cwdLine = entry.cwd !== PROJECT_ROOT ? `\n         CWD:     ${entry.cwd}` : "";
    let envLine = "";
    if (entry.env_vars) {
      let parsed: Record<string, string>;
      try { parsed = JSON.parse(entry.env_vars); }
      catch { throw new Error(`Corrupted env_vars for process "${entry.name}": ${entry.env_vars}`); }
      envLine = `\n         Env:     ${Object.keys(parsed).join(", ")}`;
    }
    lines.push(
      `${status} | ${entry.name} (PID ${entry.pid})\n` +
      `         Command: ${entry.command}\n` +
      `         Intent:  ${entry.intent}${cwdLine}${envLine}\n` +
      `         Started: ${entry.started_at}\n` +
      `         Log:     ${entry.log_file}`
    );
  }

  return lines.join("\n\n");
}

// ── bg_kill ──────────────────────────────────────────────────────

export function bgKill(name: string): string {
  name = sanitizeName(name);
  const entry = getProcess(PROJECT, name);

  if (!entry) {
    return `No process found with name "${name}". Use bg_list to see tracked processes.`;
  }

  if (!isAlive(entry.pid)) {
    unregisterTriggers(PROJECT, name);
    removeProcess(PROJECT, name);
    return `Process "${name}" (PID ${entry.pid}) is already dead. Removed from registry.`;
  }

  killProcessTree(entry.pid);

  // Brief wait then verify — give the OS time to reap
  const stillAlive = isAlive(entry.pid);

  unregisterTriggers(PROJECT, name);
  removeProcess(PROJECT, name);
  if (stillAlive) {
    return `Kill signal sent to "${name}" (PID ${entry.pid}) but process may still be terminating. Removed from registry.`;
  }
  return `Killed "${name}" (PID ${entry.pid}) and removed from registry.`;
}

// ── read_log ──────────────────────────────────────────────────────

export function readLog(
  name: string,
  lines: number = 50,
  raw: boolean = false,
  filter?: string | string[],
  filterRegex: boolean = false,
): string {
  name = sanitizeName(name);
  const entry = getProcess(PROJECT, name);

  if (!entry) {
    return `No process found with name "${name}".`;
  }

  if (!existsSync(entry.log_file)) {
    return `Log file not found: ${entry.log_file}`;
  }

  try {
    const alive = isAlive(entry.pid);
    const status = alive ? "ALIVE" : "DEAD";
    const result = readLogFiltered(entry.log_file, { lines, raw, filter, filterRegex });
    if (result.regexError) return `Error: ${result.regexError}`;
    const sizeMB = (result.totalSize / 1024 / 1024).toFixed(1);

    const filterLabel = filter
      ? Array.isArray(filter) ? filter.join(", ") : filter
      : "";
    const filterNote = filter
      ? ` [${filterRegex ? "regex" : "filter"}: ${filterLabel}, ${result.matchedLines} matched]`
      : "";
    return `[${entry.name}] (PID ${entry.pid}, ${status}, ${sizeMB}MB) — last ${result.returnedLines} lines${filterNote}:\n\n${result.content}`;
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

// ── bg_port_check ────────────────────────────────────────────────

export function bgPortCheck(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `Invalid port: ${port}. Must be integer 1-65535.`;

  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano`, { encoding: "utf-8", timeout: 10000 });
      const entries = parseNetstat(out, port);
      if (entries.length === 0) return `Port ${port}: nothing listening.`;

      const allProcesses = getAllProcesses();
      const lines: string[] = [];
      for (const { pid, state } of entries) {
        let pname = "unknown";
        try {
          pname = execSync(
            `powershell -NoProfile -c "(Get-Process -Id ${pid} -EA SilentlyContinue).ProcessName"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim() || "unknown";
        } catch {}
        const tracked = findTrackedEntry(pid, allProcesses);
        const tag = tracked
          ? tracked.pid === pid
            ? ` [tracked: "${tracked.name}"]`
            : ` [tracked: "${tracked.name}", child of PID ${tracked.pid}]`
          : "";
        lines.push(`  ${state} | PID ${pid} | ${pname}${tag}`);
      }
      return `Port ${port}:\n${lines.join("\n")}`;
    } else {
      const out = execSync(`ss -tlnp sport = :${port} 2>/dev/null`, { encoding: "utf-8" }).trim();
      if (!out || out.split("\n").length <= 1) return `Port ${port}: nothing listening.`;
      return `Port ${port}:\n${out}`;
    }
  } catch {
    return `Port ${port}: nothing listening.`;
  }
}

// ── bg_port_kill ─────────────────────────────────────────────────

export function bgPortKill(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `Invalid port: ${port}. Must be integer 1-65535.`;

  try {
    let pid: number | null = null;
    let processName = "unknown";

    if (process.platform === "win32") {
      const out = execSync(`netstat -ano`, { encoding: "utf-8", timeout: 10000 });
      const entries = parseNetstat(out, port).filter(e => e.state === "LISTENING");
      if (entries.length === 0) return `Port ${port}: nothing listening.`;
      pid = entries[0].pid;

      try {
        processName = execSync(`powershell -NoProfile -c "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName"`, { encoding: "utf-8", timeout: 5000 }).trim();
      } catch {}

      killProcessTree(pid);
    } else {
      const pidStr = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
      if (!pidStr) return `Port ${port}: nothing listening.`;
      pid = parseInt(pidStr, 10);
      if (isNaN(pid)) return `Port ${port}: nothing listening.`;

      try { processName = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: "utf-8" }).trim(); } catch {}
      process.kill(-pid, "SIGTERM");
    }

    // Remove from registry if tracked
    const allProcesses = getAllProcesses();
    const tracked = findTrackedEntry(pid!, allProcesses);
    if (tracked) {
      if (tracked.pid !== pid && isAlive(tracked.pid)) {
        killProcessTree(tracked.pid);
      }
      removeProcess(tracked.project, tracked.name);
      return `Killed ${processName} (PID ${pid}) on port ${port}. Removed "${tracked.name}" from registry.`;
    }

    return `Killed ${processName} (PID ${pid}) on port ${port}.`;
  } catch (e: any) {
    return `Error killing process on port ${port}: ${e.message}`;
  }
}

// ── bg_cleanup ───────────────────────────────────────────────────

export function bgCleanup(): string {
  const { removed, aliveCount } = cleanupDead(PROJECT);

  if (removed.length === 0) {
    return `No dead processes to clean up. ${aliveCount} alive.`;
  }

  const names = removed.map(e => `${e.name} (PID ${e.pid})`).join(", ");
  return `Cleaned ${removed.length} dead entries: ${names}. ${aliveCount} still alive.`;
}
