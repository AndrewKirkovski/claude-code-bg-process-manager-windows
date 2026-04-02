/**
 * MCP tool implementations: bg_run, bg_list, bg_kill, bg_logs,
 * bg_port_check, bg_port_kill, bg_cleanup.
 *
 * All functions return a plain string (displayed to Claude).
 * Tool signatures and output format are identical to v1.
 */

import { spawn, execSync } from "child_process";
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, createWriteStream } from "fs";
import { join } from "path";
import * as nodePty from "node-pty";
import {
  isAlive, sanitizeName, parseSimpleCommand, findBashPath,
  parseNetstat, findTrackedEntry, killProcessTree,
} from "./process-utils.js";
import {
  addProcess, removeProcess, getProcess, getProjectProcesses,
  getAllProcesses, cleanupDead, normalizeProject, projectSlug, LOGS_DIR,
} from "./db.js";

// Current project context (set once at startup)
let PROJECT_ROOT = process.cwd();
let PROJECT = normalizeProject(PROJECT_ROOT);

export function setProjectRoot(root: string): void {
  PROJECT_ROOT = root;
  PROJECT = normalizeProject(root);
}


// ── PTY spawn (hack for programs that need a real TTY for color output) ──

function bgRunWithPty(
  name: string, command: string, intent: string,
  logFile: string, env: Record<string, string | undefined>,
): string {
  const shellPath = findBashPath();
  let ptyProcess;
  try {
    ptyProcess = nodePty.spawn(shellPath, ["-c", command], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: PROJECT_ROOT,
      env: env as Record<string, string>,
    });
  } catch (e: any) {
    return `Error spawning PTY process: ${e.message}`;
  }

  const logStream = createWriteStream(logFile, { flags: "w" });
  ptyProcess.onData((data: string) => {
    logStream.write(data);
  });
  ptyProcess.onExit(() => {
    logStream.end();
  });

  const pid = ptyProcess.pid;

  addProcess({
    name,
    project: PROJECT,
    pid,
    command,
    intent,
    log_file: logFile,
    started_at: new Date().toISOString(),
    cwd: PROJECT_ROOT,
  });

  return `Started "${name}" (PID ${pid}, via pty)\n  Command: ${command}\n  Intent: ${intent}\n  Log: ${logFile}`;
}

// ── bg_run ───────────────────────────────────────────────────────

export function bgRun(name: string, command: string, intent: string): string {
  name = sanitizeName(name);

  // Check if name already in use
  const existing = getProcess(PROJECT, name);
  if (existing && isAlive(existing.pid)) {
    return `Error: process "${name}" is already running (PID ${existing.pid}). Kill it first with bg_kill.`;
  }

  const slug = projectSlug(PROJECT);
  const logFile = join(LOGS_DIR, `${slug}-${name}.log`);

  const spawnEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    FORCE_COLOR: "1",
  };

  // HACK: wippy.exe needs a real TTY to emit ANSI colors.
  // node-pty provides a ConPTY so the Go binary sees isatty()=true.
  const needsPty = /(?:^|[\\/\s])wippy(?:\.exe)?(?:\s|$)/.test(command);

  if (needsPty) {
    return bgRunWithPty(name, command, intent, logFile, spawnEnv);
  }

  let child;
  let spawnMode: "direct" | "shell";

  const logFd = openSync(logFile, "w");
  try {
    const parsed = parseSimpleCommand(command);

    if (parsed) {
      spawnMode = "direct";
      child = spawn(parsed.executable, parsed.args, {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: process.platform === "win32",
        env: { ...spawnEnv, ...parsed.envVars },
      });
    } else {
      spawnMode = "shell";
      const shellPath = findBashPath();

      child = spawn(shellPath, ["-c", command], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: process.platform === "win32",
        env: spawnEnv,
      });
    }
  } catch (e: any) {
    closeSync(logFd);
    return `Error spawning process: ${e.message}`;
  }
  closeSync(logFd);

  if (!child.pid) {
    return `Error: process failed to start (no PID returned)`;
  }

  child.on("error", () => { /* prevent unhandled error crash — process is detached & logged */ });
  child.unref();

  addProcess({
    name,
    project: PROJECT,
    pid: child.pid,
    command,
    intent,
    log_file: logFile,
    started_at: new Date().toISOString(),
    cwd: PROJECT_ROOT,
  });

  const modeTag = spawnMode === "direct" ? "direct" : "via shell";
  return `Started "${name}" (PID ${child.pid}, ${modeTag})\n  Command: ${command}\n  Intent: ${intent}\n  Log: ${logFile}`;
}

// ── bg_list ──────────────────────────────────────────────────────

export function bgList(): string {
  const rows = getProjectProcesses(PROJECT);
  if (rows.length === 0) return "No tracked processes.";

  const lines: string[] = [];
  for (const entry of rows) {
    const alive = isAlive(entry.pid);
    const status = alive ? "ALIVE" : "DEAD";
    lines.push(
      `${status} | ${entry.name} (PID ${entry.pid})\n` +
      `         Command: ${entry.command}\n` +
      `         Intent:  ${entry.intent}\n` +
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
    removeProcess(PROJECT, name);
    return `Process "${name}" (PID ${entry.pid}) is already dead. Removed from registry.`;
  }

  killProcessTree(entry.pid);

  // Brief wait then verify — give the OS time to reap
  const stillAlive = isAlive(entry.pid);

  removeProcess(PROJECT, name);
  if (stillAlive) {
    return `Kill signal sent to "${name}" (PID ${entry.pid}) but process may still be terminating. Removed from registry.`;
  }
  return `Killed "${name}" (PID ${entry.pid}) and removed from registry.`;
}

// ── bg_logs ──────────────────────────────────────────────────────

// Strip all ANSI escape sequences from text
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
             .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
             .replace(/\r(?!\n)/g, "");
}

export function bgLogs(
  name: string,
  lines: number = 50,
  raw: boolean = false,
  filter?: string | string[],
): string {
  name = sanitizeName(name);
  lines = Math.max(1, Math.min(1000, lines));
  const entry = getProcess(PROJECT, name);

  if (!entry) {
    return `No process found with name "${name}".`;
  }

  if (!existsSync(entry.log_file)) {
    return `Log file not found: ${entry.log_file}`;
  }

  try {
    const stat = statSync(entry.log_file);
    const alive = isAlive(entry.pid);
    const status = alive ? "ALIVE" : "DEAD";
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

    const MAX_READ = 64 * 1024;
    let content: string;
    if (stat.size > MAX_READ) {
      const fd = openSync(entry.log_file, "r");
      try {
        const buf = Buffer.alloc(MAX_READ);
        readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
        content = buf.toString("utf-8");
        const firstNewline = content.indexOf("\n");
        if (firstNewline > 0) content = content.slice(firstNewline + 1);
      } finally {
        closeSync(fd);
      }
    } else {
      content = readFileSync(entry.log_file, "utf-8");
    }

    let allLines = content.split("\n");

    // Apply filter(s) — match against stripped text so ANSI codes don't interfere
    if (filter) {
      const patterns = Array.isArray(filter) ? filter : [filter];
      const lowerPatterns = patterns.filter(p => p.length > 0).map(p => p.toLowerCase());
      if (lowerPatterns.length > 0) {
        allLines = allLines.filter(line => {
          const plain = stripAnsi(line).toLowerCase();
          return lowerPatterns.some(p => plain.includes(p));
        });
      }
    }

    let tail = allLines.slice(-lines).join("\n");

    // Strip ANSI by default (raw=true preserves them)
    if (!raw) {
      tail = stripAnsi(tail);
    }

    const filterNote = filter
      ? ` [filter: ${Array.isArray(filter) ? filter.join(", ") : filter}]`
      : "";
    return `[${entry.name}] (PID ${entry.pid}, ${status}, ${sizeMB}MB) — last ${lines} lines${filterNote}:\n\n${tail}`;
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
