#!/usr/bin/env node
/**
 * bg-manager — MCP server for background process management.
 *
 * Tools:
 *   bg_run(name, command, intent)  — spawn a background process with auto-logging
 *   bg_list()                       — list all tracked processes with status
 *   bg_kill(name)                   — kill a tracked process by name
 *   bg_logs(name, lines?)           — read last N lines from a process log
 *   bg_port_check(port)             — check what's listening on a port
 *   bg_port_kill(port)              — kill whatever is listening on a port
 *   bg_cleanup()                    — remove dead entries from registry
 *
 * Registry: .local/bg-processes.json
 * Logs:     .local/bg-logs/<name>.log
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";

// Paths relative to project root (CWD when launched)
const PROJECT_ROOT = process.cwd();
const REGISTRY_PATH = join(PROJECT_ROOT, ".local", "bg-processes.json");
const LOGS_DIR = join(PROJECT_ROOT, ".local", "bg-logs");

interface ProcessEntry {
  name: string;
  pid: number;
  command: string;
  intent: string;
  logFile: string;
  startedAt: string;
  cwd: string;
}

// --- Registry ---

function ensureDirs(): void {
  const localDir = join(PROJECT_ROOT, ".local");
  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function loadRegistry(): ProcessEntry[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveRegistry(entries: ProcessEntry[]): void {
  ensureDirs();
  writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid <= 4194304;
}

function isAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    // Works on both Windows and Linux — signal 0 checks existence without killing
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Command Parsing ---

/**
 * Check if a command needs a shell (has unquoted shell metacharacters).
 * If yes → bash -c (PID = bash wrapper). If no → direct spawn (PID = actual process).
 */
function needsShell(command: string): boolean {
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
function parseSimpleCommand(command: string): {
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

  // Extract leading ENV=VAL tokens
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

// --- Parent PID Lookup ---

function getParentPid(pid: number): number | null {
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
 * Walk up the parent chain to find a tracked registry entry.
 * Handles the bash-wrapper case: port shows node PID, parent is tracked bash PID.
 */
function findTrackedEntry(pid: number, registry: ProcessEntry[]): ProcessEntry | undefined {
  let currentPid: number | null = pid;
  for (let depth = 0; depth < 5 && currentPid !== null; depth++) {
    const tracked = registry.find(e => e.pid === currentPid);
    if (tracked) return tracked;
    currentPid = getParentPid(currentPid);
  }
  return undefined;
}

// --- Tools ---

function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  if (!sanitized || !/[a-zA-Z0-9]/.test(sanitized)) {
    return "unnamed_process";
  }
  return sanitized;
}

function bgRun(name: string, command: string, intent: string): string {
  name = sanitizeName(name);
  ensureDirs();

  // Check if name already in use
  const registry = loadRegistry();
  const existing = registry.find((e) => e.name === name);
  if (existing && isAlive(existing.pid)) {
    return `Error: process "${name}" is already running (PID ${existing.pid}). Kill it first with bg_kill.`;
  }

  // Remove stale entry with same name
  const filtered = registry.filter((e) => e.name !== name);

  const logFile = join(LOGS_DIR, `${name}.log`);

  const spawnEnv = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
  let child;
  let spawnMode: "direct" | "shell";

  const logFd = openSync(logFile, "w");
  try {
    // Try direct spawn first (PID = actual process), fall back to bash for complex commands
    const parsed = parseSimpleCommand(command);

    if (parsed) {
      // Direct spawn — PID is the actual process, not a bash wrapper
      spawnMode = "direct";
      child = spawn(parsed.executable, parsed.args, {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        windowsHide: process.platform === "win32",
        env: { ...spawnEnv, ...parsed.envVars },
      });
    } else {
      // Complex command (pipes, &&, redirects) — needs shell wrapper
      spawnMode = "shell";
      let shellPath = "bash";
      if (process.platform === "win32") {
        const gitBashPaths = [
          "C:\\Program Files\\Git\\bin\\bash.exe",
          "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
          "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ];
        for (const p of gitBashPaths) {
          if (existsSync(p)) { shellPath = p; break; }
        }
      }

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

  child.unref();

  const entry: ProcessEntry = {
    name,
    pid: child.pid,
    command,
    intent,
    logFile,
    startedAt: new Date().toISOString(),
    cwd: PROJECT_ROOT,
  };

  filtered.push(entry);
  saveRegistry(filtered);

  const modeTag = spawnMode === "direct" ? "direct" : "via shell";
  return `Started "${name}" (PID ${child.pid}, ${modeTag})\n  Command: ${command}\n  Intent: ${intent}\n  Log: ${logFile}`;
}

function bgList(): string {
  const registry = loadRegistry();
  if (registry.length === 0) return "No tracked processes.";

  const lines: string[] = [];
  for (const entry of registry) {
    const alive = isAlive(entry.pid);
    const status = alive ? "ALIVE" : "DEAD";
    lines.push(
      `${status} | ${entry.name} (PID ${entry.pid})\n` +
      `         Command: ${entry.command}\n` +
      `         Intent:  ${entry.intent}\n` +
      `         Started: ${entry.startedAt}\n` +
      `         Log:     ${entry.logFile}`
    );
  }

  return lines.join("\n\n");
}

function bgKill(name: string): string {
  name = sanitizeName(name);
  const registry = loadRegistry();
  const entry = registry.find((e) => e.name === name);

  if (!entry) {
    return `No process found with name "${name}". Use bg_list to see tracked processes.`;
  }

  if (!isAlive(entry.pid)) {
    // Remove dead entry
    saveRegistry(registry.filter((e) => e.name !== name));
    return `Process "${name}" (PID ${entry.pid}) is already dead. Removed from registry.`;
  }

  try {
    if (process.platform === "win32") {
      // Kill process tree via PowerShell — NEVER use taskkill (MSYS mangles flags).
      // Recursive: kill children first, then parent.
      const ps = `function KillTree($id){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -EA SilentlyContinue | ForEach-Object { KillTree $_.ProcessId }; Stop-Process -Id $id -Force -EA SilentlyContinue } KillTree ${entry.pid}`;
      execSync(`powershell -NoProfile -c "${ps}"`, { stdio: "ignore", timeout: 10000 });
    } else {
      // Linux: kill process group
      process.kill(-entry.pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }

  // Remove from registry
  saveRegistry(registry.filter((e) => e.name !== name));
  return `Killed "${name}" (PID ${entry.pid}) and removed from registry.`;
}

function bgLogs(name: string, lines: number = 50): string {
  name = sanitizeName(name);
  lines = Math.max(1, Math.min(1000, lines));
  const registry = loadRegistry();
  const entry = registry.find((e) => e.name === name);

  if (!entry) {
    return `No process found with name "${name}".`;
  }

  if (!existsSync(entry.logFile)) {
    return `Log file not found: ${entry.logFile}`;
  }

  try {
    const stat = statSync(entry.logFile);
    const alive = isAlive(entry.pid);
    const status = alive ? "ALIVE" : "DEAD";
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

    // For large files, read only the tail to avoid memory issues
    const MAX_READ = 64 * 1024; // 64KB max
    let content: string;
    if (stat.size > MAX_READ) {
      const fd = openSync(entry.logFile, "r");
      try {
        const buf = Buffer.alloc(MAX_READ);
        readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
        content = buf.toString("utf-8");
        // Skip first partial line
        const firstNewline = content.indexOf("\n");
        if (firstNewline > 0) content = content.slice(firstNewline + 1);
      } finally {
        closeSync(fd);
      }
    } else {
      content = readFileSync(entry.logFile, "utf-8");
    }

    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    return `[${entry.name}] (PID ${entry.pid}, ${status}, ${sizeMB}MB) — last ${lines} lines:\n\n${tail}`;
  } catch (e: any) {
    return `Error reading log: ${e.message}`;
  }
}

/**
 * Parse netstat -ano output for a specific port.
 * Returns unique PIDs with their state that match the exact port number.
 */
function parseNetstat(output: string, port: number): Array<{ pid: number; state: string }> {
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

function bgPortCheck(port: number): string {
  if (port < 1 || port > 65535) return `Invalid port: ${port}. Must be 1-65535.`;

  try {
    if (process.platform === "win32") {
      // Use netstat — Get-NetTCPConnection hangs on some Windows configs
      const out = execSync(`netstat -ano`, { encoding: "utf-8", timeout: 10000 });
      const entries = parseNetstat(out, port);
      if (entries.length === 0) return `Port ${port}: nothing listening.`;

      const registry = loadRegistry();
      const lines: string[] = [];
      for (const { pid, state } of entries) {
        let pname = "unknown";
        try {
          pname = execSync(
            `powershell -NoProfile -c "(Get-Process -Id ${pid} -EA SilentlyContinue).ProcessName"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim() || "unknown";
        } catch {}
        const tracked = findTrackedEntry(pid, registry);
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

function bgPortKill(port: number): string {
  if (port < 1 || port > 65535) return `Invalid port: ${port}. Must be 1-65535.`;

  try {
    let pid: number | null = null;
    let processName = "unknown";

    if (process.platform === "win32") {
      // Use netstat — Get-NetTCPConnection hangs on some Windows configs
      const out = execSync(`netstat -ano`, { encoding: "utf-8", timeout: 10000 });
      const entries = parseNetstat(out, port).filter(e => e.state === "LISTENING");
      if (entries.length === 0) return `Port ${port}: nothing listening.`;
      pid = entries[0].pid;

      try {
        processName = execSync(`powershell -NoProfile -c "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName"`, { encoding: "utf-8", timeout: 5000 }).trim();
      } catch { /* keep "unknown" */ }

      // Kill process tree via PowerShell — NEVER use taskkill (MSYS mangles flags)
      const killPs = `function KillTree($id){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -EA SilentlyContinue | ForEach-Object { KillTree $_.ProcessId }; Stop-Process -Id $id -Force -EA SilentlyContinue } KillTree ${pid}`;
      execSync(`powershell -NoProfile -c "${killPs}"`, { stdio: "ignore", timeout: 10000 });
    } else {
      const pidStr = execSync(`lsof -t -i :${port} -sTCP:LISTEN 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
      if (!pidStr) return `Port ${port}: nothing listening.`;
      pid = parseInt(pidStr, 10);
      if (isNaN(pid)) return `Port ${port}: nothing listening.`;

      try { processName = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: "utf-8" }).trim(); } catch {}
      process.kill(-pid, "SIGTERM");
    }

    // Remove from registry if tracked (walks up parent chain for bash-wrapper case)
    const registry = loadRegistry();
    const tracked = findTrackedEntry(pid!, registry);
    if (tracked) {
      // Also kill the tracked ancestor tree if it's a different PID (bash wrapper)
      if (tracked.pid !== pid && isAlive(tracked.pid)) {
        try {
          if (process.platform === "win32") {
            const killAncestor = `function KillTree($id){ Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -EA SilentlyContinue | ForEach-Object { KillTree $_.ProcessId }; Stop-Process -Id $id -Force -EA SilentlyContinue } KillTree ${tracked.pid}`;
            execSync(`powershell -NoProfile -c "${killAncestor}"`, { stdio: "ignore", timeout: 10000 });
          } else {
            process.kill(-tracked.pid, "SIGTERM");
          }
        } catch {}
      }
      saveRegistry(registry.filter((e) => e.name !== tracked.name));
      return `Killed ${processName} (PID ${pid}) on port ${port}. Removed "${tracked.name}" from registry.`;
    }

    return `Killed ${processName} (PID ${pid}) on port ${port}.`;
  } catch (e: any) {
    return `Error killing process on port ${port}: ${e.message}`;
  }
}

function bgCleanup(): string {
  const registry = loadRegistry();
  const alive: ProcessEntry[] = [];
  const dead: ProcessEntry[] = [];

  for (const e of registry) {
    (isAlive(e.pid) ? alive : dead).push(e);
  }

  if (dead.length === 0) {
    return `No dead processes to clean up. ${alive.length} alive.`;
  }

  saveRegistry(alive);
  const names = dead.map((e) => `${e.name} (PID ${e.pid})`).join(", ");
  return `Cleaned ${dead.length} dead entries: ${names}. ${alive.length} still alive.`;
}

// --- MCP Server ---

const server = new Server(
  { name: "bg-manager", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bg_run",
      description:
        "Start a background process with automatic logging and PID tracking. " +
        "ALWAYS use this instead of bash '&' or run_in_background for any background task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Short unique name for this process (e.g., 'scraper', 'training', 'server')",
          },
          command: {
            type: "string",
            description: "The shell command to run (e.g., 'python training/scrape.py --count 8000')",
          },
          intent: {
            type: "string",
            description: "Brief description of why this process is being started",
          },
        },
        required: ["name", "command", "intent"],
      },
    },
    {
      name: "bg_list",
      description: "List all tracked background processes with their status (alive/dead), PID, command, intent, and log file path.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "bg_kill",
      description: "Kill a tracked background process by name. Uses exact PID — never kills unrelated processes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Name of the process to kill (as given to bg_run)",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "bg_logs",
      description: "Read the last N lines from a background process's log file.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Name of the process",
          },
          lines: {
            type: "number",
            description: "Number of lines to return (default: 50)",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "bg_port_check",
      description: "Check what process is listening on a given port. Shows PID, process name, and whether it's tracked by bg-manager.",
      inputSchema: {
        type: "object" as const,
        properties: {
          port: {
            type: "number",
            description: "Port number to check (1-65535)",
          },
        },
        required: ["port"],
      },
    },
    {
      name: "bg_port_kill",
      description: "Kill whatever process is listening on a given port. Kills the entire process tree and removes from registry if tracked.",
      inputSchema: {
        type: "object" as const,
        properties: {
          port: {
            type: "number",
            description: "Port number to kill (1-65535)",
          },
        },
        required: ["port"],
      },
    },
    {
      name: "bg_cleanup",
      description: "Remove dead process entries from the registry. Does not kill anything.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result: string;

  switch (name) {
    case "bg_run":
      result = bgRun(
        (args as any).name,
        (args as any).command,
        (args as any).intent
      );
      break;
    case "bg_list":
      result = bgList();
      break;
    case "bg_kill":
      result = bgKill((args as any).name);
      break;
    case "bg_logs":
      result = bgLogs((args as any).name, (args as any).lines ?? 50);
      break;
    case "bg_port_check":
      result = bgPortCheck((args as any).port);
      break;
    case "bg_port_kill":
      result = bgPortKill((args as any).port);
      break;
    case "bg_cleanup":
      result = bgCleanup();
      break;
    default:
      result = `Unknown tool: ${name}`;
  }

  return { content: [{ type: "text", text: result }] };
});

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
