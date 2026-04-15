#!/usr/bin/env node
/**
 * bg-manager — MCP server for background process management.
 *
 * v2: SQLite database at ~/.bg-manager/, web UI dashboard, ANSI color capture.
 *
 * Tools:
 *   bg_run(name, command, intent, triggers?, working_dir?, env?)  — spawn a background process with auto-logging
 *   sync_run(name, command, intent, timeout_sec?, working_dir?, env?, lines?, raw?, filter?, filter_regex?, max_bytes?)  — run synchronously, convert to bg on timeout
 *   bg_list()                       — list all tracked processes with status
 *   bg_kill(name)                   — kill a tracked process by name
 *   read_log(name, lines?, raw?, filter?, filter_regex?) — read and filter a process log
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
import { setProjectRoot, bgRun, syncRun, bgList, bgKill, readLog, bgPortCheck, bgPortKill, bgCleanup } from "./tools.js";
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
      "ALWAYS use sync_run instead of redirecting output to temp files for one-off commands — it returns full output + exit code, and converts to background if it exceeds timeout.\n" +
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
      name: "sync_run",
      description:
        "Run a command synchronously and return its captured output + exit code + duration when it finishes.\n" +
        "- USE THIS INSTEAD of redirecting output to temp files. Patterns like 'cmd > /tmp/out.log 2>&1 && cat /tmp/out.log' are BANNED — sync_run captures stdout+stderr reliably, returns the exit code, and never leaves orphaned temp files.\n" +
        "- Same spawn engine as bg_run (direct / shell fallback, ConPTY for wippy, same env defaults, same PYTHONUTF8 detection). Same working_dir / env params.\n" +
        "- If the command doesn't finish within timeout_sec, it is AUTOMATICALLY CONVERTED to a background process and a partial-output response is returned. Watch further progress with read_log name=<name>, stop it with bg_kill.\n" +
        "- Accepts the SAME log-filtering params as read_log (lines, raw, filter) — use 'filter' to grep the output for patterns like 'error', 'FAIL', etc. Case-insensitive substring match.\n" +
        "- **FULL OUTPUT IS PERSISTED TO DISK** at ~/.bg-manager/logs/<slug>-<name>.log and the registry entry stays after completion. This means: if your filter returned too few results, or you want to see different lines, or you got the tail but need to search for something else — **DO NOT RE-RUN THE COMMAND**. Call read_log(name=<same name>, filter=..., lines=...) to re-filter the already-captured output. read_log and sync_run share the exact same filtering semantics, so anything you can do in one you can do in the other.\n" +
        "- Sync runs show up in the dashboard tagged SYNC. Clear finished entries with bg_cleanup.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Short unique name for this run (e.g., 'build', 'test-unit'). Used for log file + registry.",
          },
          command: {
            type: "string",
            description: "Command to run. Simple commands spawn directly. Shell metacharacters (|, &, ;, >) trigger Git Bash.",
          },
          intent: {
            type: "string",
            description: "Brief description of why this is being run",
          },
          timeout_sec: {
            type: "number",
            description: "Seconds to wait before converting to background (default 30, max 3600). Set higher for long-running commands; the auto-conversion means you don't have to get this exactly right.",
          },
          working_dir: {
            type: "string",
            description: "Working directory (absolute path). Defaults to project root.",
          },
          env: {
            type: "object",
            description: "Extra environment variables. Merged on top of defaults; user keys win.",
            additionalProperties: { type: "string" },
          },
          lines: {
            type: "number",
            description: "Last N lines of output to return (default 200, max 1000). Applied AFTER filter so you get the last N matching lines.",
          },
          raw: {
            type: "boolean",
            description: "If true, preserve ANSI color codes in the returned output. Default: false (stripped).",
          },
          filter: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Show only output lines matching this pattern (or any of these). Case-insensitive. Matching is done against ANSI-stripped text. Default: substring. Use filter_regex=true for regex patterns like '^FAIL' or '\\\\berror\\\\b'.",
          },
          filter_regex: {
            type: "boolean",
            description: "If true, treat each filter entry as a case-insensitive regex. Default: false (substring match).",
          },
          max_bytes: {
            type: "number",
            description: "Max bytes of log tail to read from disk before filtering (default 262144 = 256KB, max 1MB). Oversized logs are trimmed to a line boundary. Increase for very chatty commands.",
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
        "- Short-lived commands (builds, probes) go DEAD quickly — check read_log for output.",
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
      name: "read_log",
      description:
        "Read and filter the log of ANY tracked process — both bg_run (background processes) and sync_run (synchronous runs). General-purpose log reader.\n" +
        "- **Works on completed sync_run entries too.** After a sync_run finishes, its full output stays on disk. If you want to re-examine it with a different filter or see more/fewer lines — DO NOT re-run the command. Call read_log with the same name and new filter/lines params. Same filter semantics as sync_run, so anything that works in one works here.\n" +
        "- Tails the last N lines (default 50, max 1000). Large files (>64KB) are automatically trimmed to the tail.\n" +
        "- ANSI color codes stripped by default; raw=true preserves them.\n" +
        "- Use filter to grep the output. Default: case-insensitive substring (single string or array-OR). Set filter_regex=true to treat each filter entry as a case-insensitive regex — enables patterns like '^FAIL', '\\\\berror\\\\b', 'warn.*deprecated'.\n" +
        "- Filter is applied BEFORE the 'lines' cap, so you get the last N matching lines. The response header shows 'N matched' so you know if your filter caught more than you see.\n" +
        "- Empty output = process printed nothing to stdout/stderr (check quoting, buffering, or if the process exited immediately).",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Name of the process",
          },
          lines: {
            type: "number",
            description: "Number of lines to return (default: 50, max: 1000)",
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
            description: "Show only lines matching this pattern (or any of these patterns). Case-insensitive. Matching is done against ANSI-stripped text. Default mode is substring; set filter_regex=true for regex.",
          },
          filter_regex: {
            type: "boolean",
            description: "If true, treat each filter entry as a case-insensitive regex pattern (e.g., '^ERROR', '\\\\bwarn\\\\b', 'failed.*timeout'). Default: false (substring match).",
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
    case "sync_run":
      result = await syncRun(
        (args as any).name,
        (args as any).command,
        (args as any).intent,
        {
          timeoutSec: (args as any).timeout_sec,
          workingDir: (args as any).working_dir,
          env: (args as any).env,
          lines: (args as any).lines,
          raw: (args as any).raw,
          filter: (args as any).filter,
          filterRegex: (args as any).filter_regex,
          maxBytes: (args as any).max_bytes,
        },
      );
      break;
    case "bg_list":
      result = bgList();
      break;
    case "bg_kill":
      result = bgKill((args as any).name);
      break;
    case "read_log":
      result = readLog(
        (args as any).name,
        (args as any).lines ?? 50,
        (args as any).raw ?? false,
        (args as any).filter,
        (args as any).filter_regex ?? false,
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

// Safety net: log fatal errors before exiting
process.on("uncaughtException", (err) => {
  process.stderr.write(`bg-manager: uncaught exception: ${err.stack ?? err.message}\n`);
  shutdownAllTriggers();
  shutdownHttpServer();
  closeDb();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`bg-manager: unhandled rejection: ${detail}\n`);
});

main().catch(console.error);
