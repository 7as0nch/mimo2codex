// In-memory pub/sub + ring buffer for computer-use action events.
//
// The mimo-computer-use MCP server runs as a child of Codex (a different
// process from this proxy), so it can't push UI updates directly. Instead it
// POSTs each action to /admin/api/computer-use/events; this module fans those
// out to any admin "Monitor" pages listening on the SSE stream, and keeps the
// last N so a newly opened page can replay recent activity.

export interface ComputerUseEvent {
  ts: number;
  type: string; // "state" | "click" | "type" | "key" | "scroll" | …
  [key: string]: unknown;
}

const MAX_HISTORY = 200;
const history: ComputerUseEvent[] = [];
const subscribers = new Set<(evt: ComputerUseEvent) => void>();

export function pushComputerUseEvent(raw: Record<string, unknown>): ComputerUseEvent {
  const evt: ComputerUseEvent = {
    ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
    type: typeof raw.type === "string" ? raw.type : "unknown",
    ...raw,
  };
  history.push(evt);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  for (const fn of subscribers) {
    try {
      fn(evt);
    } catch {
      /* a slow/broken subscriber must not break ingestion */
    }
  }
  return evt;
}

export function subscribeComputerUse(fn: (evt: ComputerUseEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function recentComputerUseEvents(limit = 30): ComputerUseEvent[] {
  return history.slice(-limit);
}
