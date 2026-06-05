import { getCursorPos } from "./nutjs.mjs";

// Human-takeover watcher.
//
// The AI and the user share ONE physical cursor. We track where the AI last
// left the cursor; before the next AI action we read the real cursor position
// and, if it has drifted beyond a threshold, conclude the USER moved it (took
// over / is correcting). The action is then blocked so the AI yields and asks
// the user what to change. Re-observing with computer_state re-baselines and
// clears the flag.
//
// Pure nut.js (mouse.getPosition) — works without Electron. Disable with
// MIMO_COMPUTER_USE_WATCH=off; tune the pixel threshold with
// MIMO_COMPUTER_USE_WATCH_THRESHOLD (default 8).

let lastAiPos = null; // {x,y} where the AI last positioned the cursor
let intervened = false;

function threshold() {
  const n = Number(process.env.MIMO_COMPUTER_USE_WATCH_THRESHOLD);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

export function watchEnabled() {
  const v = (process.env.MIMO_COMPUTER_USE_WATCH || "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

// Record where the AI just put the cursor (after a click / scroll-with-move).
export function recordAiCursor(x, y) {
  if (Number.isFinite(x) && Number.isFinite(y)) lastAiPos = { x: Math.round(x), y: Math.round(y) };
}

export function isUserInControl() {
  return intervened;
}

// Accept the current real cursor position as the new baseline and clear the
// takeover flag (called when the AI re-observes via computer_state).
export async function rebaseline() {
  const cur = await getCursorPos();
  lastAiPos = cur ?? null;
  intervened = false;
}

// Before an AI action: did the user move the mouse since the AI left it?
// Returns { from, to, dx, dy } on takeover, else null.
export async function checkUserTakeover() {
  if (!watchEnabled() || !lastAiPos) return null;
  const cur = await getCursorPos();
  if (!cur) return null;
  const dx = Math.abs(cur.x - lastAiPos.x);
  const dy = Math.abs(cur.y - lastAiPos.y);
  if (dx > threshold() || dy > threshold()) {
    intervened = true;
    return { from: { ...lastAiPos }, to: cur, dx, dy };
  }
  return null;
}
