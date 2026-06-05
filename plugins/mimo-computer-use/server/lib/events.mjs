import { stderr } from "node:process";

// The MCP server is launched by Codex, NOT by the mimo2codex proxy, so the
// admin "live monitor" panel can't see our actions directly. We push every
// action to the proxy's ingest endpoint over localhost HTTP; the proxy keeps a
// ring buffer and re-streams it to the panel via SSE. Fire-and-forget: the
// proxy may not be running (Codex used standalone) and that must never break a
// computer-use call.

function adminBase() {
  return (process.env.MIMO2CODEX_ADMIN_URL || "http://127.0.0.1:8788").replace(/\/+$/, "");
}

// Disable entirely with MIMO_COMPUTER_USE_NO_TELEMETRY=1 (e.g. running Codex
// without the proxy and not wanting the per-action localhost POST attempts).
function enabled() {
  const v = (process.env.MIMO_COMPUTER_USE_NO_TELEMETRY || "").toLowerCase();
  return !(v === "1" || v === "true" || v === "on");
}

export async function postEvent(event) {
  if (!enabled() || typeof fetch !== "function") return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${adminBase()}/admin/api/computer-use/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts: Date.now(), ...event }),
      signal: controller.signal,
    });
  } catch (e) {
    // Proxy down / unreachable is the normal standalone case — stay quiet but
    // leave a faint breadcrumb on stderr for debugging.
    stderr.write(`computer-use: event post skipped (${e?.message ?? e})\n`);
  } finally {
    clearTimeout(timer);
  }
}
