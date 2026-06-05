import * as nutjs from "./nutjs.mjs";

// nut.js is the single, pure-Node backend (macOS + Windows). The old
// MIMO_COMPUTER_USE_BACKEND knob (which selected the external Trope CUA binary)
// is gone — there is nothing else to choose. The function is kept so callers
// don't churn and a future backend could slot in here.
export function chooseAdapter() {
  return { name: "nutjs", module: nutjs };
}

export async function waitMs(ms) {
  const capped = Math.max(0, Math.min(Number(ms ?? 1000), 60_000));
  await new Promise((resolve) => setTimeout(resolve, capped));
  return { ok: true, backend: "internal", waited_ms: capped, message: "Wait completed." };
}
