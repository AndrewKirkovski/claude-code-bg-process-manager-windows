# claude-code-bg-process-manager

MCP server for managing background processes in [Claude Code](https://claude.ai/code) on Windows.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=bg-manager&config=eyJjb21tYW5kIjoiY21kIC9jIG5weCAteSBnaXRodWI6QW5kcmV3S2lya292c2tpL2NsYXVkZS1jb2RlLWJnLXByb2Nlc3MtbWFuYWdlci13aW5kb3dzIn0%3D)

![bg-manager dashboard](screenshot.png)

## Why This Exists

Claude Code on Windows (Git Bash / MSYS2) has a fundamental process management problem. Without this tool, Claude Code will repeatedly:

1. **Forget PIDs** — starts a background process, loses the PID, then can't kill it later
2. **Try `taskkill`** — which MSYS/Git Bash flag-mangles (`/T /F /PID` become Unix paths), failing every time
3. **Try bash `kill`** — which operates on MSYS PIDs, not Windows PIDs, silently doing nothing
4. **Blanket-kill by process name** — desperate, it runs `taskkill /IM node.exe /F` or equivalent, killing ALL node processes including itself, other dev servers, and unrelated tools
5. **Try `Get-NetTCPConnection`** — which hangs indefinitely on many Windows configurations
6. **Lose output** — `run_in_background` and `&` don't capture logs, so when something fails there's no way to diagnose it

This is not a one-time issue — **Claude Code re-discovers these failures every session** because it has no persistent memory of what works on Windows. Even with `CLAUDE.md` instructions saying "use PowerShell Stop-Process", Claude Code still needs to compose the right invocation, track PIDs manually, and handle edge cases like process trees and shell wrappers.

### What this MCP server provides

- **SQLite database** — all process metadata stored in `~/.bg-manager/bg-manager.db` (WAL mode), shared across all projects
- **Web dashboard** — live process monitoring at `http://127.0.0.1:7890` with xterm.js terminal rendering, SSE live updates, and kill/cleanup actions
- **Automatic PID tracking** — every `bg_run` records the PID, command, intent, and timestamp
- **Reliable process killing** — `bg_kill` uses PowerShell `Stop-Process` with recursive tree kill (children first, then parent). Never `taskkill`, never bash `kill`
- **Log capture with colors** — all stdout/stderr goes to `~/.bg-manager/logs/`, with PTY support for programs that need `isatty()=true` for color output
- **Port management** — `bg_port_check` uses `netstat -ano` (the only reliable method on Windows), correlates PIDs with tracked processes by walking the parent chain
- **Cross-project visibility** — all projects share one central database, viewable in the web dashboard
- **Smart spawning** — simple commands spawn directly (PID = actual process), complex commands (pipes, `&&`) spawn via Git Bash with proper wrapper tracking. Command parsing uses [`shell-quote`](https://www.npmjs.com/package/shell-quote) so quoted paths with spaces (`"C:/Program Files/node.exe"`) work correctly.
- **Synchronous runs** — `sync_run` waits for a command to finish and returns its full output + exit code in one tool call. If the command exceeds its timeout, it's automatically converted to a background process — so long-running commands don't waste tokens on partial polling loops, they just flip to `read_log` follow-up.
- **Python-friendly** — automatically sets `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` for every process, and adds `PYTHONUTF8=1` when the command's executable looks like a Python interpreter (`python`, `python3`, `py`).

## Tools

| Tool | Description |
|------|-------------|
| `bg_run(name, command, intent, triggers?, working_dir?, env?)` | Start a background process with auto-logging, PID tracking, optional triggers, custom working directory, and extra env vars |
| `sync_run(name, command, intent, timeout_sec?, working_dir?, env?, lines?, raw?, filter?, filter_regex?, max_bytes?)` | Run a command **synchronously** and return its captured output + exit code + duration when it finishes. Accepts the **same log-filtering params as `read_log`** (`lines`, `raw`, `filter`, `filter_regex`) so you can grep the output in a single call. If it exceeds `timeout_sec` (default 30, max 3600), the process is automatically **converted to a background process** and a partial-output response is returned with follow-up hints. The full captured log is persisted on disk — re-read with a different filter via `read_log` instead of re-running the command. |
| `bg_list()` | List all tracked processes with alive/dead status |
| `bg_kill(name)` | Kill a tracked process by name (full process tree) |
| `read_log(name, lines?, raw?, filter?, filter_regex?)` | Read and filter the log of any tracked process (both `bg_run` and `sync_run`). Tails the last N lines (default 50, max 1000). ANSI stripped by default (`raw=true` preserves). `filter` is case-insensitive substring by default; set `filter_regex=true` to switch to regex (e.g. `^FAIL`, `\\berror\\b`, `warn.*deprecated`). Filter is applied before the line cap, and the response header shows how many lines matched. |
| `bg_port_check(port)` | Check what's listening on a port (with tracked process correlation) |
| `bg_port_kill(port)` | Kill whatever is listening on a port |
| `bg_cleanup()` | Remove dead entries from registry |
| `bg_status()` | Show dashboard URL, database path, and project info |

## Prerequisites

- **Node.js** (v18+) — required for `npx`
- **[Git for Windows](https://git-scm.com/downloads/win)** — provides Git Bash, which bg-manager uses to spawn complex commands (pipes, `&&`, redirects). Simple commands spawn directly without a shell.

## Install

### Cursor (one click)

Click the badge at the top of this README, or use the button below:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=bg-manager&config=eyJjb21tYW5kIjoiY21kIC9jIG5weCAteSBnaXRodWI6QW5kcmV3S2lya292c2tpL2NsYXVkZS1jb2RlLWJnLXByb2Nlc3MtbWFuYWdlci13aW5kb3dzIn0%3D)

### Claude Code

```bash
# Global (all projects)
claude mcp add -s user bg-manager -- cmd /c npx -y github:AndrewKirkovski/claude-code-bg-process-manager-windows

# Per-project only (creates .mcp.json in current directory)
claude mcp add bg-manager -- cmd /c npx -y github:AndrewKirkovski/claude-code-bg-process-manager-windows
```

### Manual (any MCP client)

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "bg-manager": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "github:AndrewKirkovski/claude-code-bg-process-manager-windows"]
    }
  }
}
```

### From source (local development)

```bash
git clone git@github.com:AndrewKirkovski/claude-code-bg-process-manager-windows.git
cd claude-code-bg-process-manager-windows
npm install && npm run build

# Then add to Claude Code pointing to local build:
claude mcp add -s user bg-manager node /path/to/claude-code-bg-process-manager-windows/dist/index.js
```

## Storage

- **Database:** `~/.bg-manager/bg-manager.db` (SQLite, WAL mode)
- **Logs:** `~/.bg-manager/logs/<project-slug>-<name>.log`
- **Web UI:** `http://127.0.0.1:7890` (auto-increments if port is taken)

All data is centralized in `~/.bg-manager/` — shared across all projects. Legacy `.local/bg-processes.json` registries are automatically migrated on first run.

## Web Dashboard

The built-in web dashboard at `http://127.0.0.1:7890` provides:

- **Live process list** grouped by project with ALIVE/DEAD status badges
- **xterm.js terminal** — full terminal emulation with ANSI color rendering
- **SSE live updates** — process status and log streaming update in real-time
- **Kill/cleanup actions** — manage processes directly from the browser
- **Project filter** — focus on a specific project's processes
- **Dark/light themes** — OneDark Pro (dark) / Bluloco Light (light) with CSS filter inversion
- **Hash routing** — direct links to processes via `/#/:project/:name`

The dashboard starts automatically when the MCP server launches. Use `bg_status` to get the actual URL (port may increment if 7890 is taken).

## Agent Notes

If you're an AI agent using this MCP server, here's what to expect:

- **Execution environment** — env vars come from the IDE that spawned bg-manager (VSCODE_*, CURSOR_*, ELECTRON_*, etc.), not the user's interactive terminal. PATH may differ from what the user sees in their shell.
- **Working directory & env vars** — use `working_dir` to set the process CWD and `env` to pass extra environment variables. These are preferred over chaining `cd /path && VAR=val && cmd` in the command string:
  ```jsonc
  // Preferred:
  bg_run(name='server', command='wippy.exe run -c',
         working_dir='C:/Projects/navi-server', env={"PORT": "3000"})
  // Instead of:
  bg_run(name='server', command='cd C:/Projects/navi-server && PORT=3000 && ./wippy.exe run -c')
  ```
  `working_dir` defaults to the project root when omitted. `env` is merged with the base environment (does not replace it).
- **Spawn behavior** — bg-manager never uses cmd.exe or COMSPEC. Simple commands (e.g. `node server.js`, `python app.py`) spawn directly with no shell. Commands containing shell metacharacters (`|`, `&`, `;`, `>`) spawn via Git Bash (`bash -c '...'`).
- **Log contents** — logs only contain stdout/stderr from the spawned process. Empty logs mean the process produced no output (wrong path, immediate crash, buffered output, or bad quoting).
- **ALIVE vs DEAD** — DEAD means the process exited, not necessarily that it failed. Exit codes are captured automatically (exit 0 = success, non-zero = failure). Short-lived commands (builds, probes, one-shot scripts) go DEAD as soon as they complete. Check `read_log` for the actual output.
- **Shell builtins** — `echo`, `cd`, etc. are not executables on Windows. Direct spawn fails for bare `echo hello`. Add a metacharacter to trigger Git Bash: `echo hello && echo done`, or use an actual executable: `node -e "console.log('hello')"`.
- **Smoke test** — to verify bg-manager works: `bg_run(name='probe', command='node -e "console.log(42)"', intent='test')` then `read_log(name='probe')`. Should show `42`.

## Triggers

`bg_run` supports an optional `triggers` parameter for monitoring process events. Trigger notifications are delivered **piggybacked on the next tool response** — when Claude calls any bg-manager tool, pending alerts are prepended to the result.

```jsonc
bg_run(
  name: "server",
  command: "node app.js",
  intent: "start dev server",
  working_dir: "C:/Projects/my-app",   // optional: override CWD
  env: { "NODE_ENV": "development" },  // optional: extra env vars (merged)
  triggers: {
    "notifyDead": true,        // alert when process exits (default: true)
    "notifyReady": true,       // detect "ready"/"listening"/"started" patterns
    "notifyPort": true,        // detect localhost:PORT patterns in output
    "logTriggers": [           // custom regex patterns to watch for
      { "pattern": "ERROR", "once": true },
      { "pattern": "warning.*deprecated" }
    ]
  }
)
```

**How delivery works:** MCP servers cannot push unsolicited messages. Instead, trigger events queue in memory and are prepended to the next tool response as a `=== TRIGGER ALERTS ===` block. This means Claude sees them the next time it calls `bg_list`, `read_log`, or any other bg-manager tool.

## Synchronous Runs (`sync_run`)

Use `sync_run` instead of redirecting output to a temp file when you just want a command's output back in one shot:

```jsonc
// Quick test run — returns full output + exit code when it finishes
sync_run(
  name: "unit",
  command: "npm test -- --run",
  intent: "run the unit suite",
  timeout_sec: 60,          // default 30
  filter: "FAIL",           // grep the output in one call
  lines: 50
)

// Regex filter — show the last 20 stack-frame-looking lines
sync_run(
  name: "lint",
  command: "pnpm eslint src",
  intent: "lint check",
  filter: "(error|^\\s+at )",
  filter_regex: true,
  lines: 20
)

// Long-running command — on timeout, bg-manager hands you control back
sync_run(
  name: "heavy-build",
  command: "npm run build:all",
  intent: "full production build",
  timeout_sec: 10
)
// => "sync_run \"heavy-build\" DID NOT FINISH within 10s — converted to background.
//     Follow with: read_log name=\"heavy-build\" | stop with: bg_kill name=\"heavy-build\"
//     Partial output (...): ..."
```

**Key properties:**

- **Same spawn engine as `bg_run`** — direct spawn for simple commands, Git Bash fallback for shell features, ConPTY for wippy. Same `working_dir` / `env` params. Same Python env defaults.
- **Same log-filtering params as `read_log`** — `lines`, `raw`, `filter`, `filter_regex` work identically in both tools, so you don't have to learn two APIs. Filter is case-insensitive substring by default; flip `filter_regex: true` for regex patterns like `^FAIL` or `\berror\b`.
- **Full output is persisted on disk** at `~/.bg-manager/logs/<slug>-<name>.log` and the registry entry stays after completion. If your filter dropped too many lines, or you want to re-examine the output with different criteria — **do not re-run the command**. Call `read_log(name=<same name>, filter=..., lines=..., filter_regex=...)` to re-filter the already-captured log. This is the intended workflow: `sync_run` to execute, `read_log` to iterate.
- **Timeout → background conversion** is transparent: the process keeps running, the log file keeps growing, and it shows up in `bg_list` tagged `SYNC`. Follow it with `read_log` exactly like a `bg_run` process.
- **Output is trimmed on a line boundary** to `max_bytes` (default 256KB, max 1MB). Oversized output gets the last N bytes of the disk file, so you always see the most recent lines. Filter matches are counted against everything read from disk, and `lines` caps the returned slice.
- **Piggyback events** queued by triggers on other processes (e.g. a background server dying while `sync_run` is waiting for a build to finish) are captured and prepended to the `sync_run` response — no events are lost during the wait.
- **Strip colors by default** — `raw: false` (default) strips ANSI codes from the returned output. Pass `raw: true` to keep them.

## SessionStart Hook (optional)

Shows bg-manager status at the start of every Claude Code session. The hook calls a script bundled with bg-manager — all logic lives in the script, so you can update it without changing settings.

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<path-to-bg-manager>/scripts/session-start.cjs\"",
            "timeout": 3000
          }
        ]
      }
    ]
  }
}
```

Replace `<path-to-bg-manager>` with the actual install path. For npm global installs, find it with `npm root -g`. For local dev: use the repo path directly.

## CLAUDE.md Integration

Add the following to your project's `CLAUDE.md` (or global `~/.claude/CLAUDE.md`) to ensure Claude Code always uses bg-manager instead of raw bash:

```markdown
## Process Management — MANDATORY
- **ALWAYS use `bg-manager` MCP tools** (`bg_run`, `sync_run`, `bg_list`, `bg_kill`, `read_log`) for ALL process execution. NEVER use bash `&`, `run_in_background`, or redirect output to temp files.
- `bg_run` — start a long-lived background process (servers, watchers). Automatically captures PID, logs stdout/stderr to `~/.bg-manager/logs/`, tracks metadata (intent, command, start time).
- `bg_list` shows all tracked processes with alive/dead status — check what's running.
- `bg_kill <name>` kills by exact PID from registry — never kills unrelated processes.
- `read_log <name>` reads and filters the log of ANY tracked process (both `bg_run` and `sync_run` entries). Use instead of `tail -f` / `grep` on unknown files.
- **BEFORE starting ANY server/process**: run `bg_list` to check what's already running. `bg_kill` old one first.
- **BEFORE editing server code**: `bg_list`, `bg_kill` the server, then edit, rebuild, `bg_run`.
- NEVER blanket-kill by process name — always by exact name via `bg_kill`.
- NEVER use bash `&` directly — use `bg_run` (persistent) or `sync_run` (one-shot) instead.

## Capturing command output — use `sync_run`, not redirection — MANDATORY
- **NEVER** redirect command output to a temp file just to read it back. Patterns like `cmd > /tmp/out.log 2>&1 && cat /tmp/out.log`, `cmd | tee /tmp/out.log`, or `cmd 2>&1 > output.txt` are BANNED. They are unreliable on Windows/Git Bash (path handling, cp1252 encoding, partial flushes, orphaned temp files) and they throw away the exit code.
- **ALWAYS use `sync_run`** when you need the output AND exit code of a one-shot command — builds, tests, linters, scripts, `git` operations, `npm run …`, `pytest`, anything you'd normally want to "run and see what happened".
  - `sync_run` runs the command, waits for it to finish, and returns the full captured stdout+stderr, exit code, and duration in a single tool call. No temp files, no redirection, no parsing ceremony.
  - It uses the same spawn engine as `bg_run` — so `working_dir`, `env`, Python UTF-8 defaults, `.cmd`/`.ps1` shim fallback, and wippy ConPTY all work identically.
- **Timeout handling is automatic.** Pass `timeout_sec` (default 30, max 3600). If the command doesn't finish by then, bg-manager transparently converts it to a background process and returns a "did-not-finish" message with a `read_log name=<name>` hint. You don't lose the process, you don't lose partial output, and you don't have to guess durations up front — start with a modest `timeout_sec`, and if it rolls over, follow up with `read_log` as normal.
- **Filter the output in one call.** `sync_run` accepts the same `lines`, `filter`, `filter_regex`, and `raw` params as `read_log`. Use `filter` to grep for patterns like `"error"`, `"FAIL"`, or `"^WARN"` (with `filter_regex: true`). The response header shows how many lines matched, so you know if there's more.
- **Correct usage patterns:**
  ```
  sync_run(name="build", command="npm run build", intent="production build", timeout_sec=120)
  sync_run(name="lint", command="pnpm eslint src", intent="lint check", filter="error", lines=50)
  sync_run(name="pytest", command="python -m pytest tests/ -v", intent="unit tests", filter="FAIL|^E ", filter_regex=true, timeout_sec=300)
  sync_run(name="git-status", command="git status --short", intent="check working tree")
  ```
- **BANNED patterns** (never write these — use `sync_run` instead):
  ```
  npm run build > /tmp/build.log 2>&1 && cat /tmp/build.log  # BANNED
  pytest tests/ | tee /tmp/pytest.log                         # BANNED
  node script.js 2>&1 > .local/out.txt                        # BANNED
  ```

## Re-filter logs — don't re-run — MANDATORY
- **The full output of every `sync_run` is persisted to disk** at `~/.bg-manager/logs/<slug>-<name>.log` and the registry entry stays after completion (tagged `SYNC` in the dashboard). Until you run `bg_cleanup`, you can re-read the already-captured log any number of times.
- **If your first `sync_run` filter was too narrow, too broad, or just wrong — DO NOT re-run the command.** Re-running is slow, wastes tokens, and can give different results (flaky tests, non-deterministic builds, different timestamps). Instead, call `read_log` on the same name with a different `filter` / `lines` / `filter_regex`:
  ```
  # Step 1: run once
  sync_run(name="test", command="npm test", intent="run tests", filter="FAIL", lines=10)
  # => 3 matched, last 10 lines shown — wait, I want to see the assertion details

  # Step 2: re-read WITHOUT re-running — instant, uses the persisted log
  read_log(name="test", filter="Expected|Actual|AssertionError", filter_regex=true, lines=30)

  # Step 3: widen the net to see passing tests too
  read_log(name="test", lines=200)  # no filter = full tail
  ```
- `read_log` and `sync_run` share the exact same filter engine, so anything you can do in one works in the other. Learn one, use both.
- The only reason to re-run a `sync_run` is if the source code / inputs actually changed. Before re-running, ask: "could I answer my question by re-filtering the existing log?" If yes, use `read_log`.

## Regex filtering — when substring isn't enough
- By default, `filter` is a case-insensitive substring match — `filter: "error"` catches `ERROR`, `errors`, `SomeError`, etc. Array form (`filter: ["error", "warn"]`) is OR-matched.
- For anchored or structured patterns, pass `filter_regex: true`. Each `filter` entry is then compiled as a case-insensitive regex:
  ```
  read_log(name="build", filter="^FAIL", filter_regex=true)                    # anchored
  read_log(name="build", filter="\\berror\\b", filter_regex=true)              # word boundary
  read_log(name="build", filter="warn.*deprecated", filter_regex=true)         # pattern
  read_log(name="build", filter=["^E\\s", "^F\\s"], filter_regex=true)         # array-OR regex
  ```
- Invalid regex returns a clear error — fix the pattern and retry, no re-run needed.
```

This is important because without these instructions, Claude Code will default to its built-in `run_in_background` which loses PID tracking and makes process management unreliable on Windows.

## How It Works

### Process spawning
- Commands are parsed with [`shell-quote`](https://www.npmjs.com/package/shell-quote), which handles quoted paths with spaces correctly (`"C:/Program Files/node.exe" --version`)
- Simple commands (no pipes/redirects) are spawned directly — PID is the actual process
- Complex commands (with `&&`, `|`, `;`, etc.) spawn via Git Bash — PID is the bash wrapper
- `.cmd` / `.ps1` shims (pnpm, npx, etc.) transparently fall back from direct spawn to shell mode on Windows
- `working_dir` sets the CWD for the spawned process (defaults to project root)
- `env` adds extra environment variables, merged on top of the inherited environment (user `env` wins over every default)
- All output (stdout + stderr) is redirected to `~/.bg-manager/logs/<project-slug>-<name>.log`
- Every process gets `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, and `FORCE_COLOR=1` by default
- Commands whose first token is a Python interpreter (`python`, `python3`, `py`, or any `*.exe` variant — detected via shell-quote-parsed tokens so quoted paths work) additionally get `PYTHONUTF8=1`
- `bg_run` and `sync_run` share a single internal `spawnProcess()` helper, so any fix to the spawn path benefits both tools automatically

### Process killing (Windows)
- Uses PowerShell `Stop-Process` with recursive tree kill — kills children first, then parent
- Never uses `taskkill` (MSYS flag mangling) or bash `kill` (wrong PID namespace)
- Port-based kill walks the parent PID chain to find tracked ancestors

### Port checking
- Uses `netstat -ano` — the only reliable method on Windows
- Never uses `Get-NetTCPConnection` (hangs on some configs)
- Correlates port PIDs with tracked processes by walking parent chain

### Architecture

```
MCP Client (Claude/Cursor) <--stdio--> bg-manager <--HTTP:7890--> Web Browser
                                           |
                                           v
                                  ~/.bg-manager/
                                    bg-manager.db   (SQLite, WAL mode)
                                    logs/           (per-process log files)
```

## Attribution

[Process icons created by Freepik - Flaticon](https://www.flaticon.com/free-icons/process)

## License

MIT
