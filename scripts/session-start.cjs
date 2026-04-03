#!/usr/bin/env node
/**
 * SessionStart hook for Claude Code.
 * Outputs bg-manager dashboard URL and process summary.
 *
 * Hook config (in .claude/settings.json or ~/.claude/settings.json):
 *   "hooks": { "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node \"/path/to/scripts/session-start.js\"" }] }] }
 */

const http = require("http");

const PORT = parseInt(process.env.BG_MANAGER_PORT || "7890", 10);
const URL = `http://127.0.0.1:${PORT}`;

function fetch(url, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  let context;
  try {
    const raw = await fetch(`${URL}/api/processes`);
    const processes = JSON.parse(raw);
    const alive = processes.filter((p) => p.alive).length;
    const dead = processes.filter((p) => !p.alive).length;
    const parts = [`Dashboard: ${URL}`];
    if (alive > 0 || dead > 0) {
      parts.push(`${alive} alive, ${dead} dead`);
    }
    context = `[bg-manager] ${parts.join(" | ")}`;
  } catch {
    context = `[bg-manager] Dashboard: ${URL} (server starting...)`;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  };
  console.log(JSON.stringify(output));
}

main().catch(() => process.exit(0));
