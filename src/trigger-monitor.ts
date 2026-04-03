/**
 * Process trigger monitoring engine.
 * Watches for death, port binding, readiness, and log pattern matches.
 */

import { watchFile, unwatchFile, statSync, openSync, readSync, closeSync } from "fs";
import { isAlive, stripAnsi } from "./process-utils.js";
import { queueTriggerEvent } from "./notifier.js";
import type { TriggerConfig, TriggerState } from "./types.js";

// ── Port / ready detection patterns ─────────────────────────────

const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i,
  /listening\s+(?:on\s+)?(?:port\s+)?(\d+)/i,
  /started\s+(?:on\s+)?(?:port\s+)?(\d+)/i,
  /server\s+(?:running\s+)?(?:at|on)\s+(?:port\s+)?(\d+)/i,
];

const READY_PATTERNS = [
  /listening\s+on/i,
  /server\s+(?:is\s+)?(?:running|started|ready)/i,
  /ready\s+(?:on|at|in)/i,
  /compiled\s+successfully/i,
  /build\s+succeeded/i,
  /watching\s+for\s+(?:file\s+)?changes/i,
];

// ── Monitor state ───────────────────────────────────────────────

interface CompiledLogTrigger {
  regex: RegExp;
  once: boolean;
}

interface MonitorHandle {
  state: TriggerState;
  deathTimer?: ReturnType<typeof setInterval>;
  logWatcherCleanup?: () => void;
}

const monitors = new Map<string, MonitorHandle>();

function monitorKey(project: string, name: string): string {
  return `${project}/${name}`;
}

// ── Death monitor ───────────────────────────────────────────────

function startDeathMonitor(key: string, pid: number, processName: string): void {
  const handle = monitors.get(key);
  if (!handle) return;

  handle.deathTimer = setInterval(() => {
    if (!isAlive(pid)) {
      handle.state.firedDead = true;
      clearInterval(handle.deathTimer!);
      queueTriggerEvent(
        processName, "dead",
        `Process "${processName}" (PID ${pid}) has exited.`,
      );
    }
  }, 2000);
  handle.deathTimer.unref();
}

// ── Log monitor (port, ready, pattern triggers) ─────────────────

function startLogMonitor(
  key: string,
  logFile: string,
  processName: string,
  config: TriggerConfig,
): void {
  const handle = monitors.get(key);
  if (!handle) return;

  let offset = 0;
  try { offset = statSync(logFile).size; } catch {}

  // Compile log trigger regexes
  const compiled: CompiledLogTrigger[] = [];
  if (config.logTriggers) {
    for (const entry of config.logTriggers) {
      try {
        compiled.push({ regex: new RegExp(entry.pattern, "i"), once: entry.once ?? false });
      } catch {
        process.stderr.write(`[bg-manager] Invalid regex in logTriggers: ${entry.pattern}\n`);
      }
    }
  }

  // Rolling line buffer for context
  const lineBuffer: string[] = [];
  const MAX_BUFFER = 5;

  function processLine(stripped: string): void {
    lineBuffer.push(stripped);
    if (lineBuffer.length > MAX_BUFFER) lineBuffer.shift();

    // Port detection
    if (config.notifyPort) {
      for (const re of PORT_PATTERNS) {
        const m = stripped.match(re);
        if (m) {
          const port = m[1];
          if (!handle!.state.firedPorts.has(port)) {
            handle!.state.firedPorts.add(port);
            queueTriggerEvent(
              processName, "port",
              `Process "${processName}" listening at http://localhost:${port}`,
            );
          }
        }
      }
    }

    // Ready detection
    if (config.notifyReady && !handle!.state.firedReady) {
      for (const re of READY_PATTERNS) {
        if (re.test(stripped)) {
          handle!.state.firedReady = true;
          queueTriggerEvent(
            processName, "ready",
            `Process "${processName}" is ready: ${stripped.slice(0, 200)}`,
          );
          break;
        }
      }
    }

    // Log trigger matching
    for (const trigger of compiled) {
      const patternKey = trigger.regex.source;
      if (trigger.once && handle!.state.firedLogOnce.has(patternKey)) continue;
      if (trigger.regex.test(stripped)) {
        if (trigger.once) handle!.state.firedLogOnce.add(patternKey);
        // Build context: up to 2 lines before + match
        const contextLines = lineBuffer.slice(-3);
        const context = contextLines.join("\n");
        queueTriggerEvent(
          processName, "log_match",
          `Process "${processName}" matched /${patternKey}/: ${stripped.slice(0, 200)}`,
          context,
        );
      }
    }
  }

  const listener = (curr: { size: number }) => {
    if (curr.size < offset) offset = 0; // truncation
    if (curr.size <= offset) return;

    try {
      const fd = openSync(logFile, "r");
      try {
        const readLen = Math.min(curr.size - offset, 64 * 1024);
        const buf = Buffer.alloc(readLen);
        readSync(fd, buf, 0, readLen, offset);
        offset += readLen;
        const text = buf.toString("utf-8");

        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const stripped = stripAnsi(line);
          processLine(stripped);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // File might be gone
    }
  };

  watchFile(logFile, { interval: 1000 }, listener);
  handle.logWatcherCleanup = () => unwatchFile(logFile, listener);
}

// ── Public API ──────────────────────────────────────────────────

export function registerTriggers(
  project: string,
  name: string,
  pid: number,
  logFile: string,
  triggers: TriggerConfig,
): void {
  const key = monitorKey(project, name);
  unregisterTriggers(project, name);

  const state: TriggerState = {
    config: triggers,
    firedDead: false,
    firedReady: false,
    firedPorts: new Set(),
    firedLogOnce: new Set(),
  };

  monitors.set(key, { state });

  if (triggers.notifyDead !== false) {
    startDeathMonitor(key, pid, name);
  }

  const needsLogWatch = triggers.notifyPort
    || triggers.notifyReady
    || (triggers.logTriggers && triggers.logTriggers.length > 0);

  if (needsLogWatch) {
    startLogMonitor(key, logFile, name, triggers);
  }
}

export function unregisterTriggers(project: string, name: string): void {
  const key = monitorKey(project, name);
  const handle = monitors.get(key);
  if (!handle) return;
  if (handle.deathTimer) clearInterval(handle.deathTimer);
  if (handle.logWatcherCleanup) handle.logWatcherCleanup();
  monitors.delete(key);
}

export function shutdownAllTriggers(): void {
  for (const [, handle] of monitors) {
    if (handle.deathTimer) clearInterval(handle.deathTimer);
    if (handle.logWatcherCleanup) handle.logWatcherCleanup();
  }
  monitors.clear();
}

/** Returns active trigger info for a process (for dashboard display). */
export function getActiveTriggers(project: string, name: string): {
  config: TriggerConfig;
  state: { firedDead: boolean; firedReady: boolean; firedPorts: string[]; firedLogOnce: string[] };
} | null {
  const handle = monitors.get(monitorKey(project, name));
  if (!handle) return null;
  return {
    config: handle.state.config,
    state: {
      firedDead: handle.state.firedDead,
      firedReady: handle.state.firedReady,
      firedPorts: [...handle.state.firedPorts],
      firedLogOnce: [...handle.state.firedLogOnce],
    },
  };
}
