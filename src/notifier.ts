/**
 * Notification system for process triggers — 5 parallel channels.
 *
 * Every trigger event fires ALL channels simultaneously. Each message
 * is prefixed with its transport tag so we can observe which ones
 * actually reach the client.
 *
 * Channels:
 *   [LOG]       — server.sendLoggingMessage() (MCP logging push)
 *   [ELICIT]    — server.elicitInput() (interactive dialog, fire-and-forget)
 *   [RAW]       — server.notification() with custom method "notifications/claude/channel"
 *   [STDERR]    — process.stderr.write()
 *   [PIGGYBACK] — queued, prepended to next tool response
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface TriggerEvent {
  processName: string;
  eventType: "dead" | "port" | "ready" | "log_match";
  message: string;
  context?: string;
  timestamp: string;
}

// ── Server reference (set once at startup) ──────────────────────

let mcpServer: Server | null = null;

export function setServer(server: Server): void {
  mcpServer = server;
}

// ── Shared formatter ────────────────────────────────────────────

function formatEventText(event: TriggerEvent): string {
  const icon =
    event.eventType === "dead"  ? "EXITED" :
    event.eventType === "port"  ? "PORT" :
    event.eventType === "ready" ? "READY" :
    "LOG_MATCH";

  return event.context
    ? `[${icon}] ${event.message}\n${event.context}`
    : `[${icon}] ${event.message}`;
}

// ── Channel 1: LOG — sendLoggingMessage ─────────────────────────

function channelLog(event: TriggerEvent): void {
  if (!mcpServer) return;
  const text = `[LOG] ${formatEventText(event)}`;
  mcpServer.sendLoggingMessage({
    level: event.eventType === "dead" ? "warning" : "info",
    logger: "bg-manager",
    data: text,
  }).catch(() => {});
}

// ── Channel 2: ELICIT — elicitInput ────────────────────────────
// VIABLE: Works in Claude Code — shows interactive dialog to user.
// Requires accept/decline/cancel (no display-only mode in MCP spec).
// Good for critical alerts that need user acknowledgement.
// Disabled for now — revisit when we want user-facing alert UX.
//
// function channelElicit(event: TriggerEvent): void {
//   if (!mcpServer) return;
//   const text = `[ELICIT] ${formatEventText(event)}`;
//   try {
//     (mcpServer as any).elicitInput({
//       message: text,
//       requestedSchema: {
//         type: "object",
//         properties: {
//           acknowledged: {
//             type: "boolean",
//             title: "Acknowledged",
//             description: text,
//             default: true,
//           },
//         },
//       },
//     }).catch(() => {});
//   } catch {
//     // Client doesn't support elicitation — swallow
//   }
// }

// ── Channel 3: RAW — custom notification method ─────────────────

function channelRaw(event: TriggerEvent): void {
  if (!mcpServer) return;
  const text = `[RAW] ${formatEventText(event)}`;
  try {
    (mcpServer as any).notification({
      method: "notifications/claude/channel",
      params: {
        channel: "bg-manager",
        data: text,
      },
    }).catch(() => {});
  } catch {
    // Transport not connected or method rejected — swallow
  }
}

// ── Channel 4: STDERR — direct stderr output ────────────────────

function channelStderr(event: TriggerEvent): void {
  const text = `[STDERR] ${formatEventText(event)}`;
  try {
    process.stderr.write(`[bg-manager] ${text}\n`);
  } catch {
    // Swallow
  }
}

// ── Channel 5: PIGGYBACK — queue for next tool response ─────────

const pendingEvents: TriggerEvent[] = [];

export function queueTriggerEvent(
  processName: string,
  eventType: "dead" | "port" | "ready" | "log_match",
  message: string,
  context?: string,
): void {
  const event: TriggerEvent = {
    processName,
    eventType,
    message,
    context,
    timestamp: new Date().toISOString(),
  };

  // Fire all push channels in parallel — each independently error-isolated
  channelLog(event);
  // channelElicit(event);  // disabled — see Channel 2 comment above
  channelRaw(event);
  channelStderr(event);

  // Channel 5: queue for piggyback on next tool response
  pendingEvents.push(event);
}

/**
 * Drain all pending trigger events and format them as a text block.
 * Returns empty string if no events are pending.
 */
export function drainPendingEvents(): string {
  if (pendingEvents.length === 0) return "";

  const lines = pendingEvents.map((e) => {
    const icon =
      e.eventType === "dead" ? "EXITED" :
      e.eventType === "port" ? "PORT" :
      e.eventType === "ready" ? "READY" :
      "LOG_MATCH";
    let line = `  [PIGGYBACK] [${icon}] ${e.message}`;
    if (e.context) line += `\n         ${e.context.replace(/\n/g, "\n         ")}`;
    return line;
  });

  pendingEvents.length = 0;

  return (
    "=== TRIGGER ALERTS ===\n" +
    lines.join("\n") +
    "\n======================\n\n"
  );
}
