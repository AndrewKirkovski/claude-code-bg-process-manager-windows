#!/usr/bin/env node
/**
 * bg-manager — MCP server for background process management.
 *
 * v2: SQLite database at ~/.bg-manager/, web UI dashboard, ANSI color capture.
 *
 * Tools:
 *   bg_run(name, command, intent, triggers?, working_dir?, env?)  — spawn a background process with auto-logging
 *   bg_list()                       — list all tracked processes with status
 *   bg_kill(name)                   — kill a tracked process by name
 *   bg_logs(name, lines?, raw?, filter?) — read last N lines from a process log
 *   bg_port_check(port)             — check what's listening on a port
 *   bg_port_kill(port)              — kill whatever is listening on a port
 *   bg_cleanup()                    — remove dead entries from registry
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ensureDb, closeDb, DB_PATH } from "./db.js";
import { migrateFromJson } from "./migrate.js";
import { startHttpServer, shutdownHttpServer } from "./server.js";
import { setProjectRoot, bgRun, bgList, bgKill, bgLogs, bgPortCheck, bgPortKill, bgCleanup } from "./tools.js";
import { drainPendingEvents, setServer } from "./notifier.js";
import { shutdownAllTriggers } from "./trigger-monitor.js";

// Tracks the actual HTTP port after startup (may differ from 7890 if port taken)
let httpPort: number | null = null;
export function getHttpPort(): number | null { return httpPort; }

// ── MCP Server ───────────────────────────────────────────────────

const server = new Server(
  { name: "bg-manager", version: "2.0.0" },
  {
    capabilities: { tools: {}, logging: {} },
    instructions:
      "Background process manager for Windows with a live web dashboard.\n" +
      "Dashboard: http://127.0.0.1:7890 (port may increment — use bg_status for actual URL).\n" +
      "ALWAYS use bg_run instead of bash '&' or run_in_background.\n" +
      "BEFORE starting any process, run bg_list to check what's already running.\n\n" +
      "AGENT NOTES (Windows execution environment):\n" +
      "- Env vars come from the IDE that spawned bg-manager (VSCODE_*, CURSOR_*, ELECTRON_*, etc.), NOT the user's interactive terminal. PATH may differ.\n" +
      "- bg-manager NEVER uses cmd.exe or COMSPEC. Simple commands (e.g. 'node server.js') spawn directly with no shell. Complex commands (|, &, ;, >) spawn via Git Bash.\n" +
      "- Logs capture stdout/stderr only. Empty logs = process printed nothing (wrong path, immediate crash, or output buffered). Check ALIVE/DEAD status.\n" +
      "- DEAD = process exited (success or failure). Short tasks go DEAD quickly — that's normal.\n" +
      "- Smoke test: bg_run(name='probe', command='node -e \"console.log(42)\"', intent='env check') — shell builtins like echo need metacharacters to trigger bash (e.g. 'echo hi && echo done').\n" +
      "- Use working_dir to set the process CWD (e.g. working_dir='C:/Projects/my-app'). Use env to pass extra vars (e.g. env={\"PORT\": \"3000\"}). Prefer these over 'cd /path && VAR=val' in the command string.\n\n" +
      "TRIGGERS:\n" +
      "- bg_run accepts optional 'triggers' to monitor process events (death, port binding, readiness, log patterns).\n" +
      "- Trigger alerts are delivered via PIGGYBACK: queued in-memory and prepended to the NEXT tool response from this server.\n" +
      "- To collect pending alerts, call bg_status or bg_list — any bg-manager tool call will drain the queue.\n" +
      "- Each MCP client gets only its own alerts (separate process per stdio connection).",
  }
);

// Wire server reference so notifier can push via sendLoggingMessage
setServer(server);

// Trigger notifications: push via logging + piggyback on tool responses

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bg_run",
      description:
        "Start a background process with automatic logging and PID tracking.\n" +
        "- ALWAYS use this instead of bash '&' or run_in_background.\n" +
        "- Use working_dir to set the process CWD instead of 'cd /path &&' in the command. Use env to pass environment variables instead of 'VAR=val' prefix.\n" +
        "- Simple commands (no pipes/redirects) spawn directly. Complex commands (with |, &, ;, >) spawn via Git Bash.\n" +
        "- Inherits IDE extension host env, not the user's terminal session. Extra env vars passed via env are merged on top.\n" +
        "- Logs capture stdout/stderr. Empty logs = nothing printed (wrong path, immediate crash, or buffered output).\n" +
        "- DEAD = process exited (success or failure). Short-lived commands go DEAD quickly — that's normal, check logs.\n" +
        "- Shell builtins (echo, cd) fail in direct mode — add a metachar to trigger bash: 'echo hi && echo done'.\n" +
        "- Smoke test: bg_run(name='probe', command='node -e \"console.log(42)\"', intent='test')",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Short unique name for this process (e.g., 'server', 'build', 'probe')",
          },
          command: {
            type: "string",
            description: "Command to run. Simple commands spawn directly (e.g. 'node server.js'). Shell metacharacters (|, &, ;, >) trigger Git Bash. Avoid complex quoting — use scripts for elaborate pipelines.",
          },
          intent: {
            type: "string",
            description: "Brief description of why this process is being started",
          },
          triggers: {
            type: "object",
            description:
              "Optional monitoring triggers. Events are delivered via PIGGYBACK — prepended to the next tool response. Call bg_status or bg_list periodically to collect pending alerts.",
            properties: {
              notifyDead: {
                type: "boolean",
                description: "Notify when process exits (default: true)",
              },
              notifyPort: {
                type: "boolean",
                description: "Detect localhost:PORT patterns in output, notify with URL",
              },
              notifyReady: {
                type: "boolean",
                description: "Detect 'ready'/'listening'/'started'/'compiled' patterns, notify once",
              },
              logTriggers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    pattern: { type: "string", description: "Regex pattern to match against log lines" },
                    once: { type: "boolean", description: "If true, fire only on first match (default: false — fire every match)" },
                  },
                  required: ["pattern"],
                },
                description: "Regex patterns to watch for in log output",
              },
            },
          },
          working_dir: {
            type: "string",
            description: "Working directory for the process (absolute path). Defaults to the project root. Prefer this over 'cd /path &&' in the command.",
          },
          env: {
            type: "object",
            description: "Extra environment variables to set. Merged with the base environment (does not replace). Example: {\"NODE_ENV\": \"production\", \"PORT\": \"3000\"}. Prefer this over 'VAR=val' prefix in the command.",
            additionalProperties: { type: "string" },
          },
        },
        required: ["name", "command", "intent"],
      },
    },
    {
      name: "bg_list",
      description:
        "List all tracked processes with status (ALIVE/DEAD), PID, command, intent, log path.\n" +
        "- ALIVE = process still running. DEAD = exited (may have succeeded or failed).\n" +
        "- Short-lived commands (builds, probes) go DEAD quickly — check bg_logs for output.",
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
      description:
        "Read the last N lines from a process log file.\n" +
        "- ANSI color codes stripped by default; raw=true preserves them.\n" +
        "- Empty output = process printed nothing to stdout/stderr (check quoting, buffering, or if process exited immediately).\n" +
        "- Use filter to search for specific strings in the output.",
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
    {
      name: "bg_status",
      description: "Show bg-manager status: web dashboard URL, database path, and process summary.",
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
        (args as any).intent,
        (args as any).triggers,
        (args as any).working_dir,
        (args as any).env,
      );
      break;
    case "bg_list":
      result = bgList();
      break;
    case "bg_kill":
      result = bgKill((args as any).name);
      break;
    case "bg_logs":
      result = bgLogs(
        (args as any).name,
        (args as any).lines ?? 50,
        (args as any).raw ?? false,
        (args as any).filter,
      );
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
    case "bg_status": {
      const port = getHttpPort();
      const url = port ? `http://127.0.0.1:${port}` : "not started";
      result = `bg-manager v2.0.0\n  Dashboard: ${url}\n  Database:  ${DB_PATH}\n  Project:   ${process.cwd()}`;
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  // Piggyback: prepend any pending trigger notifications to the response
  const alerts = drainPendingEvents();
  return { content: [{ type: "text", text: alerts + result }] };
});

// ── Startup ──────────────────────────────────────────────────────

async function main() {
  // Initialise database
  ensureDb();

  // Set project context
  setProjectRoot(process.cwd());

  // Migrate legacy per-project JSON registry if present
  migrateFromJson(process.cwd());

  // Start web dashboard (non-blocking)
  startHttpServer().then((port) => {
    httpPort = port;
    process.stderr.write(
      `\n  bg-manager v2.0.0\n` +
      `  Dashboard: http://127.0.0.1:${port}\n` +
      `  Database:  ${DB_PATH}\n` +
      `  Project:   ${process.cwd()}\n\n`
    );
  }).catch((err) => {
    process.stderr.write(`bg-manager: failed to start web UI: ${err.message}\n`);
  });

  // Start MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Graceful shutdown ────────────────────────────────────────────

function shutdown() {
  shutdownAllTriggers();
  shutdownHttpServer();
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch(console.error);
