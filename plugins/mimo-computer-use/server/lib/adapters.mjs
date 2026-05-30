import * as macos from "../../adapters/macos/index.mjs";
import * as windows from "../../adapters/windows/index.mjs";
import * as trope from "../../adapters/shared/trope/index.mjs";

export function chooseAdapter(env = process.env, platform = process.platform) {
  const forced = (env.MIMO_COMPUTER_USE_BACKEND || "auto").toLowerCase();
  if (forced === "trope") return { name: "trope-cua", module: trope };
  if (forced === "peekaboo") return { name: "peekaboo", module: macos };
  if (forced === "windows-mcp") return { name: "windows-mcp", module: windows };
  if (platform === "darwin") return { name: "peekaboo", module: macos };
  if (platform === "win32") return { name: "windows-mcp", module: windows };
  return {
    name: "unsupported",
    module: {
      async diagnose() {
        return {
          ok: false,
          backend: "unsupported",
          platform,
          code: "unsupported_platform",
          message: "mimo-computer-use MVP supports macOS and Windows only.",
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
