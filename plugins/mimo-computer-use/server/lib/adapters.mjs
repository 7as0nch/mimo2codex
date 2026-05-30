import * as trope from "../../adapters/shared/trope/index.mjs";

// Trope CUA is the single backend (macOS + Windows). MIMO_COMPUTER_USE_BACKEND is
// kept as a forward-compatible knob (so future backends can be added without a
// config break), but "auto" / "trope" both resolve to Trope today. Any other
// explicit value is rejected so a stale "peekaboo" / "windows-mcp" in an old
// config.toml surfaces a clear error instead of silently falling back.
export function chooseAdapter(env = process.env) {
  const forced = (env.MIMO_COMPUTER_USE_BACKEND || "auto").toLowerCase();
  if (forced === "auto" || forced === "trope") {
    return { name: "trope-cua", module: trope };
  }
  return {
    name: "unsupported",
    module: {
      async diagnose() {
        return {
          ok: false,
          backend: "unsupported",
          code: "unsupported_backend",
          message:
            `MIMO_COMPUTER_USE_BACKEND="${forced}" is not supported. ` +
            `mimo-computer-use uses Trope CUA — set MIMO_COMPUTER_USE_BACKEND=trope or unset it (auto).`,
        };
      },
    },
  };
}

export async function waitMs(ms) {
  const capped = Math.max(0, Math.min(Number(ms ?? 1000), 60_000));
  await new Promise((resolve) => setTimeout(resolve, capped));
  return { ok: true, backend: "internal", waited_ms: capped, message: "Wait completed." };
}
