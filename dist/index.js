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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { ensureDb, closeDb, DB_PATH } from "./db.js";
import { migrateFromJson } from "./migrate.js";
import { startHttpServer, shutdownHttpServer } from "./server.js";
import { setProjectRoot, bgRun, bgList, bgKill, bgLogs, bgPortCheck, bgPortKill, bgCleanup } from "./tools.js";
// Tracks the actual HTTP port after startup (may differ from 7890 if port taken)
let httpPort = null;
export function getHttpPort() { return httpPort; }
// ── MCP Server ───────────────────────────────────────────────────
const server = new Server({ name: "bg-manager", version: "2.0.0" }, {
    capabilities: { tools: {} },
    instructions: "Background process manager with a live web dashboard. " +
        "Dashboard URL: http://127.0.0.1:7890 (port may increment if taken — use bg_status to get the actual URL). " +
        "ALWAYS use bg_run instead of bash '&' or run_in_background. " +
        "BEFORE starting any process, run bg_list to check what's already running.",
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "bg_run",
            description: "Start a background process with automatic logging and PID tracking. " +
                "ALWAYS use this instead of bash '&' or run_in_background for any background task.",
            inputSchema: {
                type: "object",
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
            inputSchema: { type: "object", properties: {} },
        },
        {
            name: "bg_kill",
            description: "Kill a tracked background process by name. Uses exact PID — never kills unrelated processes.",
            inputSchema: {
                type: "object",
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
            description: "Read the last N lines from a background process's log file. " +
                "ANSI color codes are stripped by default; set raw=true to preserve them. " +
                "Use filter to show only lines matching one or more search strings.",
            inputSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the process",
                    },
                    lines: {
                        type: "number",
                        description: "Number of lines to return (default: 50)",
                    },
                    raw: {
                        type: "boolean",
                        description: "If true, preserve ANSI color codes in output. Default: false (stripped).",
                    },
                    filter: {
                        oneOf: [
                            { type: "string" },
                            { type: "array", items: { type: "string" } },
                        ],
                        description: "Show only lines containing this string (or any of these strings). Case-insensitive. Matching is done against stripped text.",
                    },
                },
                required: ["name"],
            },
        },
        {
            name: "bg_port_check",
            description: "Check what process is listening on a given port. Shows PID, process name, and whether it's tracked by bg-manager.",
            inputSchema: {
                type: "object",
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
                type: "object",
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
            inputSchema: { type: "object", properties: {} },
        },
        {
            name: "bg_status",
            description: "Show bg-manager status: web dashboard URL, database path, and process summary.",
            inputSchema: { type: "object", properties: {} },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result;
    switch (name) {
        case "bg_run":
            result = bgRun(args.name, args.command, args.intent);
            break;
        case "bg_list":
            result = bgList();
            break;
        case "bg_kill":
            result = bgKill(args.name);
            break;
        case "bg_logs":
            result = bgLogs(args.name, args.lines ?? 50, args.raw ?? false, args.filter);
            break;
        case "bg_port_check":
            result = bgPortCheck(args.port);
            break;
        case "bg_port_kill":
            result = bgPortKill(args.port);
            break;
        case "bg_cleanup":
            result = bgCleanup();
            break;
        case "bg_status": {
            const port = getHttpPort();
            const url = port ? `http://127.0.0.1:${port}` : "not started";
            result = `bg-manager v2.0.0\n  Dashboard: ${url}\n  Database:  ${DB_PATH}\n  Project:   ${process.cwd()}`;
            break;
        }
        default:
            result = `Unknown tool: ${name}`;
    }
    return { content: [{ type: "text", text: result }] };
});
// ── Startup ──────────────────────────────────────────────────────
async function main() {
    // Initialise database
    ensureDb();
    // Set project context
    setProjectRoot(process.cwd());
    // Migrate legacy per-project JSON registry if present
    migrateFromJson(process.cwd());
    // Start web dashboard (non-blocking, prints URL to stderr)
    startHttpServer().then((port) => {
        httpPort = port;
    }).catch((err) => {
        process.stderr.write(`bg-manager: failed to start web UI: ${err.message}\n`);
    });
    // Start MCP stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
// ── Graceful shutdown ────────────────────────────────────────────
function shutdown() {
    shutdownHttpServer();
    closeDb();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch(console.error);
//# sourceMappingURL=index.js.map