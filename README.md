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
- **Smart spawning** — simple commands spawn directly (PID = actual process), complex commands (pipes, `&&`) spawn via Git Bash with proper wrapper tracking
- **Python-friendly** — automatically sets `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8`

## Tools

| Tool | Description |
|------|-------------|
| `bg_run(name, command, intent, triggers?, working_dir?, env?)` | Start a background process with auto-logging, PID tracking, optional triggers, custom working directory, and extra env vars |
| `bg_list()` | List all tracked processes with alive/dead status |
| `bg_kill(name)` | Kill a tracked process by name (full process tree) |
| `bg_logs(name, lines?, raw?, filter?)` | Read last N lines from a process log (ANSI stripped by default; `raw=true` preserves colors; `filter` for substring matching) |
| `bg_port_check(port)` | Check what's listening on a port (with tracked process correlation) |
| `bg_port_kill(port)` | Kill whatever is listening on a port |
| `bg_cleanup()` | Remove dead entries from registry |
| `bg_status()` | Show dashboard URL, database path, and project info |

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
- **ALIVE vs DEAD** — DEAD means the process exited, not necessarily that it failed. Exit codes are captured automatically (exit 0 = success, non-zero = failure). Short-lived commands (builds, probes, one-shot scripts) go DEAD as soon as they complete. Check `bg_logs` for the actual output.
- **Shell builtins** — `echo`, `cd`, etc. are not executables on Windows. Direct spawn fails for bare `echo hello`. Add a metacharacter to trigger Git Bash: `echo hello && echo done`, or use an actual executable: `node -e "console.log('hello')"`.
- **Smoke test** — to verify bg-manager works: `bg_run(name='probe', command='node -e "console.log(42)"', intent='test')` then `bg_logs(name='probe')`. Should show `42`.

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

**How delivery works:** MCP servers cannot push unsolicited messages. Instead, trigger events queue in memory and are prepended to the next tool response as a `=== TRIGGER ALERTS ===` block. This means Claude sees them the next time it calls `bg_list`, `bg_logs`, or any other bg-manager tool.

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
- **ALWAYS use `bg-manager` MCP tools** (`bg_run`, `bg_list`, `bg_kill`, `bg_logs`) for ALL background processes. NEVER use bash `&` or `run_in_background` directly.
- `bg_run` automatically: captures PID, logs stdout/stderr to `~/.bg-manager/logs/`, tracks metadata (intent, command, start time)
- `bg_list` shows all tracked processes with alive/dead status — check what's running
- `bg_kill <name>` kills by exact PID from registry — never kills unrelated processes
- `bg_logs <name>` reads the log tail — use instead of `tail -f` on unknown files
- **BEFORE starting ANY server/process**: run `bg_list` to check what's already running. `bg_kill` old one first.
- **BEFORE editing server code**: `bg_list`, `bg_kill` the server, then edit, rebuild, `bg_run`
- NEVER blanket-kill by process name — always by exact name via `bg_kill`
- NEVER use bash `&` directly — use `bg_run` instead
```

This is important because without these instructions, Claude Code will default to its built-in `run_in_background` which loses PID tracking and makes process management unreliable on Windows.

## How It Works

### Process spawning
- Simple commands (no pipes/redirects) are spawned directly — PID is the actual process
- Complex commands (with `&&`, `|`, `;`, etc.) spawn via Git Bash — PID is the bash wrapper
- `working_dir` sets the CWD for the spawned process (defaults to project root)
- `env` adds extra environment variables, merged on top of the inherited environment
- All output (stdout + stderr) is redirected to `~/.bg-manager/logs/<project-slug>-<name>.log`
- Python processes get `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8` automatically
- `FORCE_COLOR=1` is set to preserve ANSI color codes in log output

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
