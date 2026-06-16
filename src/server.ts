/**
 * HTTP server for the bg-manager web dashboard.
 * Serves a web UI + JSON API + SSE for live updates.
 * Bound to 127.0.0.1 only (local dev tool).
 */

import http from "http";
import { statSync, openSync, readSync, closeSync, readFileSync, watchFile, unwatchFile, existsSync } from "fs";
import { dirname, join, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { getAllProcesses, withStatus, getProcess, cleanupAllDead, removeProcess } from "./db.js";
import { isEntryAlive, pidMatchesEntry, killProcessTree } from "./process-utils.js";
import { getActiveTriggers } from "./trigger-monitor.js";
import { restartProcess } from "./tools.js";

// ── Dashboard static files ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDistDir = resolve(join(__dirname, "..", "web", "dist"));
const htmlPath = join(webDistDir, "index.html");
const fallbackHtml = `<!DOCTYPE html><html><body><p>Dashboard not built. Run <code>cd web &amp;&amp; npm run build</code> first.</p></body></html>`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf":  "font/ttf",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

function getDashboardHtml(): string {
  try {
    return readFileSync(htmlPath, "utf-8");
  } catch {
    return fallbackHtml;
  }
}

// ── SSE client tracking ──────────────────────────────────────────

function enrichWithTriggers(processes: ReturnType<typeof withStatus>) {
  return processes.map(p => ({
    ...p,
    triggers: getActiveTriggers(p.project, p.name),
  }));
}

const sseClients = new Set<http.ServerResponse>();
let previousState = new Map<string, boolean>();

// `force` bypasses the alive/dead change-detection. Needed after a restart,
// where the process stays ALIVE→ALIVE but its PID changes — a change the
// alive-keyed diff can't see, so without forcing the dashboard keeps the stale PID.
function broadcastProcessList(force = false): void {
  if (sseClients.size === 0) return;

  let processes;
  try {
    processes = withStatus(getAllProcesses());
  } catch {
    return; // DB may be closed during shutdown
  }
  const newState = new Map(processes.map(p => [`${p.project}/${p.name}`, p.alive]));

  let changed = newState.size !== previousState.size;
  if (!changed) {
    for (const [key, alive] of newState) {
      if (previousState.get(key) !== alive) { changed = true; break; }
    }
  }

  if (changed || force) {
    const payload = `event: process_list\ndata: ${JSON.stringify(enrichWithTriggers(processes))}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
    previousState = newState;
  }
}

// ── Request handling ─────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://127.0.0.1`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Dashboard
  if (method === "GET" && path === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(getDashboardHtml());
    return;
  }

  // API: all processes with status
  if (method === "GET" && path === "/api/processes") {
    sendJson(res, 200, enrichWithTriggers(withStatus(getAllProcesses())));
    return;
  }

  // API: global SSE
  if (method === "GET" && path === "/api/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    sseClients.add(res);
    req.on("close", () => { sseClients.delete(res); });

    // Send initial state
    const processes = enrichWithTriggers(withStatus(getAllProcesses()));
    res.write(`event: process_list\ndata: ${JSON.stringify(processes)}\n\n`);
    return;
  }

  // API: cleanup all dead
  if (method === "POST" && path === "/api/cleanup") {
    const { removed, aliveCount } = cleanupAllDead();
    sendJson(res, 200, { removed: removed.length, aliveCount });
    // Broadcast update
    setTimeout(broadcastProcessList, 100);
    return;
  }

  // Parameterised routes: /api/processes/:project/:name/...
  const procMatch = path.match(/^\/api\/processes\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (procMatch) {
    const [, encodedProject, encodedName, sub] = procMatch;
    let project: string, name: string;
    try {
      project = decodeURIComponent(encodedProject);
      name = decodeURIComponent(encodedName);
    } catch {
      return sendJson(res, 400, { error: "Invalid URL encoding" });
    }

    // Get logs
    if (method === "GET" && sub === "/logs") {
      const entry = getProcess(project, name);
      if (!entry) return sendJson(res, 404, { error: "Process not found" });
      if (!existsSync(entry.log_file)) return sendJson(res, 404, { error: "Log file not found" });

      // full=1 returns the entire log (no line clamp, no tail-byte cap) — used
      // by the dashboard's full-history load and the "Copy all log" button.
      const full = url.searchParams.get("full") === "1";
      const lines = parseInt(url.searchParams.get("lines") ?? "200", 10) || 200;
      const clampedLines = Math.max(1, Math.min(5000, lines));

      try {
        const content = full
          ? readLogTail(entry.log_file, Infinity, FULL_LOG_MAX_BYTES)
          : readLogTail(entry.log_file, clampedLines);
        sendJson(res, 200, { name, project, content, alive: isEntryAlive(entry) });
      } catch (e: any) {
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // SSE log stream
    if (method === "GET" && sub === "/logs/stream") {
      const entry = getProcess(project, name);
      if (!entry) return sendJson(res, 404, { error: "Process not found" });

      handleLogStream(req, res, entry.log_file);
      return;
    }

    // Kill process
    if (method === "POST" && sub === "/kill") {
      const entry = getProcess(project, name);
      if (!entry) return sendJson(res, 404, { error: "Process not found" });

      // Two-stage safety: trust recorded exit_code first (cheap), then verify
      // PID identity via WMI start time before killing (defends against PID
      // reuse — Windows can hand a recycled PID to an unrelated process).
      let killed = false;
      let reason: string | undefined;
      try {
        if (isEntryAlive(entry)) {
          if (pidMatchesEntry(entry)) {
            killProcessTree(entry.pid);
            killed = true;
          } else {
            reason = "pid_recycled";
            process.stderr.write(`bg-manager: skipped kill ${project}/${name} pid=${entry.pid} reason=pid_recycled\n`);
          }
        } else {
          reason = "already_exited";
          process.stderr.write(`bg-manager: skipped kill ${project}/${name} pid=${entry.pid} reason=already_exited\n`);
        }
        // If removeProcess throws after a successful kill, the process is
        // gone but the registry row remains — bg_list / cleanup will reap it.
        removeProcess(project, name);
        sendJson(res, 200, { killed, name, pid: entry.pid, reason });
      } catch (e: any) {
        process.stderr.write(`bg-manager: kill failed ${project}/${name} pid=${entry.pid}: ${e.message}\n`);
        sendJson(res, 500, { killed: false, error: e.message, name, pid: entry.pid });
      }
      // Broadcast update
      setTimeout(broadcastProcessList, 200);
      return;
    }

    // Restart process (kill if alive, re-spawn with same command/cwd/env)
    if (method === "POST" && sub === "/restart") {
      const result = restartProcess(project, name);
      if (!result.ok) {
        process.stderr.write(`bg-manager: restart failed ${project}/${name}: ${result.error}\n`);
        return sendJson(res, result.notFound ? 404 : 500, { error: result.error, name });
      }
      sendJson(res, 200, { restarted: true, name, pid: result.pid });
      // Force: the process is ALIVE before and after, so only the PID changed —
      // the change-detection diff would otherwise suppress this update.
      setTimeout(() => broadcastProcessList(true), 200);
      return;
    }
  }

  // Static assets from web/dist/
  if (method === "GET") {
    const safePath = path.replace(/\.\./g, "");
    const filePath = resolve(join(webDistDir, safePath));

    if (filePath.startsWith(webDistDir) && existsSync(filePath)) {
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) {
          const ext = extname(filePath);
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(readFileSync(filePath));
          return;
        }
      } catch {
        // Fall through to 404
      }
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ── Log helpers ──────────────────────────────────────────────────

// Default tail budget for the windowed (last-N-lines) read.
const DEFAULT_TAIL_BYTES = 256 * 1024; // 256KB for web UI (more generous than MCP tool)
// Ceiling for the full-log read. "No truncation" for any realistic dev log while
// guarding against OOM / V8's ~512MB max-string-length on pathological files;
// xterm's scrollback (100k lines) is the effective on-screen limit anyway.
const FULL_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Read a log file. Reads at most `maxBytes` from the end (trimmed to a line
 * boundary when the file is larger). When `lines` is finite, returns only the
 * last N lines; pass Infinity to return the whole (byte-capped) content.
 */
function readLogTail(logFile: string, lines: number, maxBytes: number = DEFAULT_TAIL_BYTES): string {
  const stat = statSync(logFile);

  let content: string;
  if (stat.size > maxBytes) {
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

  if (!Number.isFinite(lines)) return content;
  const allLines = content.split("\n");
  return allLines.slice(-lines).join("\n");
}

function handleLogStream(req: http.IncomingMessage, res: http.ServerResponse, logFile: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  let offset = 0;
  try {
    offset = statSync(logFile).size;
  } catch {
    // File may not exist yet
  }

  const listener = (curr: { size: number }) => {
    // Detect truncation (log rotation, manual clear)
    if (curr.size < offset) {
      offset = 0;
    }
    if (curr.size > offset) {
      try {
        const fd = openSync(logFile, "r");
        try {
          const readLen = Math.min(curr.size - offset, 64 * 1024);
          const buf = Buffer.alloc(readLen);
          readSync(fd, buf, 0, readLen, offset);
          offset = offset + readLen;
          const text = buf.toString("utf-8");
          res.write(`data: ${JSON.stringify(text)}\n\n`);
        } finally {
          closeSync(fd);
        }
      } catch {
        // File might be gone
      }
    }
  };

  watchFile(logFile, { interval: 500 }, listener);

  req.on("close", () => {
    unwatchFile(logFile, listener);
  });
}

// ── Server startup ───────────────────────────────────────────────

let httpServer: http.Server | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function shutdownHttpServer(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  for (const client of sseClients) {
    try { client.destroy(); } catch {}
  }
  sseClients.clear();
  previousState = new Map();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

// TODO: Make port static and configurable via MCP server args or a config file.
// Currently auto-increments on EADDRINUSE, which makes the SessionStart hook
// probe ports 7890-7899. A fixed port would simplify hooks and bookmarks.
export function startHttpServer(preferredPort?: number): Promise<number> {
  const basePort = preferredPort ?? parseInt(process.env.BG_MANAGER_PORT ?? "7890", 10);

  return new Promise((resolve, reject) => {
    let attempts = 0;

    const srv = http.createServer((req, res) => handleRequest(req, res));

    function tryBind(port: number): void {

      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < 10) {
          attempts++;
          srv.removeListener("error", onError);
          tryBind(port + 1);
        } else {
          reject(err);
        }
      };

      srv.once("error", onError);
      srv.listen(port, "127.0.0.1", () => {
        // Remove stale error listener and assign after successful bind
        srv.removeListener("error", onError);
        srv.on("error", (err) => { process.stderr.write(`bg-manager HTTP error: ${err.message}\n`); });
        httpServer = srv;
        pollInterval = setInterval(broadcastProcessList, 2000);
        pollInterval.unref();
        // Startup banner printed by index.ts after port is known
        resolve(port);
      });
    }

    tryBind(basePort);
  });
}
