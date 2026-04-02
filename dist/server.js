/**
 * HTTP server for the bg-manager web dashboard.
 * Serves a web UI + JSON API + SSE for live updates.
 * Bound to 127.0.0.1 only (local dev tool).
 */
import http from "http";
import { statSync, openSync, readSync, closeSync, readFileSync, watchFile, unwatchFile, existsSync } from "fs";
import { getAllProcesses, withStatus, getProcess, cleanupAllDead, removeProcess } from "./db.js";
import { isAlive, killProcessTree } from "./process-utils.js";
import { getUiHtml } from "./ui.js";
// ── SSE client tracking ──────────────────────────────────────────
const sseClients = new Set();
let previousState = new Map();
function broadcastProcessList() {
    if (sseClients.size === 0)
        return;
    let processes;
    try {
        processes = withStatus(getAllProcesses());
    }
    catch {
        return; // DB may be closed during shutdown
    }
    const newState = new Map(processes.map(p => [`${p.project}/${p.name}`, p.alive]));
    let changed = newState.size !== previousState.size;
    if (!changed) {
        for (const [key, alive] of newState) {
            if (previousState.get(key) !== alive) {
                changed = true;
                break;
            }
        }
    }
    if (changed) {
        const payload = `event: process_list\ndata: ${JSON.stringify(processes)}\n\n`;
        for (const client of sseClients) {
            try {
                client.write(payload);
            }
            catch {
                sseClients.delete(client);
            }
        }
        previousState = newState;
    }
}
// ── Request handling ─────────────────────────────────────────────
function sendJson(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function handleRequest(req, res, port) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    // Dashboard
    if (method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getUiHtml(port));
        return;
    }
    // API: all processes with status
    if (method === "GET" && path === "/api/processes") {
        sendJson(res, 200, withStatus(getAllProcesses()));
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
        const processes = withStatus(getAllProcesses());
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
        let project, name;
        try {
            project = decodeURIComponent(encodedProject);
            name = decodeURIComponent(encodedName);
        }
        catch {
            return sendJson(res, 400, { error: "Invalid URL encoding" });
        }
        // Get logs
        if (method === "GET" && sub === "/logs") {
            const entry = getProcess(project, name);
            if (!entry)
                return sendJson(res, 404, { error: "Process not found" });
            if (!existsSync(entry.log_file))
                return sendJson(res, 404, { error: "Log file not found" });
            const lines = parseInt(url.searchParams.get("lines") ?? "200", 10);
            const clampedLines = Math.max(1, Math.min(5000, lines));
            try {
                const content = readLogTail(entry.log_file, clampedLines);
                sendJson(res, 200, { name, project, content, alive: isAlive(entry.pid) });
            }
            catch (e) {
                sendJson(res, 500, { error: e.message });
            }
            return;
        }
        // SSE log stream
        if (method === "GET" && sub === "/logs/stream") {
            const entry = getProcess(project, name);
            if (!entry)
                return sendJson(res, 404, { error: "Process not found" });
            handleLogStream(req, res, entry.log_file);
            return;
        }
        // Kill process
        if (method === "POST" && sub === "/kill") {
            const entry = getProcess(project, name);
            if (!entry)
                return sendJson(res, 404, { error: "Process not found" });
            if (isAlive(entry.pid)) {
                killProcessTree(entry.pid);
            }
            removeProcess(project, name);
            sendJson(res, 200, { killed: true, name, pid: entry.pid });
            // Broadcast update
            setTimeout(broadcastProcessList, 200);
            return;
        }
    }
    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
}
// ── Log helpers ──────────────────────────────────────────────────
function readLogTail(logFile, lines) {
    const stat = statSync(logFile);
    const MAX_READ = 256 * 1024; // 256KB for web UI (more generous than MCP tool)
    let content;
    if (stat.size > MAX_READ) {
        const fd = openSync(logFile, "r");
        try {
            const buf = Buffer.alloc(MAX_READ);
            readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
            content = buf.toString("utf-8");
            const firstNewline = content.indexOf("\n");
            if (firstNewline > 0)
                content = content.slice(firstNewline + 1);
        }
        finally {
            closeSync(fd);
        }
    }
    else {
        content = readFileSync(logFile, "utf-8");
    }
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
}
function handleLogStream(req, res, logFile) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
    });
    let offset = 0;
    try {
        offset = statSync(logFile).size;
    }
    catch {
        // File may not exist yet
    }
    const listener = (curr) => {
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
                }
                finally {
                    closeSync(fd);
                }
            }
            catch {
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
let httpServer = null;
let pollInterval = null;
export function shutdownHttpServer() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    for (const client of sseClients) {
        try {
            client.destroy();
        }
        catch { }
    }
    sseClients.clear();
    previousState = new Map();
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}
export function startHttpServer(preferredPort) {
    const basePort = preferredPort ?? parseInt(process.env.BG_MANAGER_PORT ?? "7890", 10);
    return new Promise((resolve, reject) => {
        let chosenPort = basePort;
        let attempts = 0;
        const srv = http.createServer((req, res) => handleRequest(req, res, chosenPort));
        function tryBind(port) {
            chosenPort = port;
            const onError = (err) => {
                if (err.code === "EADDRINUSE" && attempts < 10) {
                    attempts++;
                    srv.removeListener("error", onError);
                    tryBind(port + 1);
                }
                else {
                    reject(err);
                }
            };
            srv.once("error", onError);
            srv.listen(port, "127.0.0.1", () => {
                // Remove stale error listener and assign after successful bind
                srv.removeListener("error", onError);
                httpServer = srv;
                pollInterval = setInterval(broadcastProcessList, 2000);
                pollInterval.unref();
                process.stderr.write(`bg-manager UI: http://127.0.0.1:${port}\n`);
                resolve(port);
            });
        }
        tryBind(basePort);
    });
}
//# sourceMappingURL=server.js.map