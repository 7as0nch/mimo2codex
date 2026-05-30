import { commandExists } from "../../../server/lib/shell.mjs";
import { callExternalMcp } from "../../../server/lib/external-mcp-client.mjs";

const COMMAND = process.env.MIMO_COMPUTER_USE_TROPE_CMD || "trope-cua";
const ARGS = (process.env.MIMO_COMPUTER_USE_TROPE_ARGS || "mcp")
  .split(/\s+/)
  .filter(Boolean);

async function hasTrope() {
  return await commandExists(COMMAND);
}

function missing() {
  return {
    ok: false,
    backend: "trope-cua",
    code: "adapter_missing",
    message:
      "Trope CUA is not available. Install Trope CUA and set MIMO_COMPUTER_USE_BACKEND=trope when you want this shared adapter.",
    install: "See https://trope.ai/cua and https://github.com/voctory/trope-cua.",
  };
}

async function call(tool, args, timeoutMs) {
  if (!(await hasTrope())) return missing();
  const result = await callExternalMcp(COMMAND, ARGS, tool, args, { timeoutMs });
  return {
    ok: result.ok,
    backend: "trope-cua",
    command: [COMMAND, ...ARGS],
    tool,
    result: result.result ?? null,
    stderr: (result.stderr ?? "").trim(),
    message: result.ok ? "Trope CUA tool completed." : `Trope CUA tool failed: ${result.error}`,
  };
}

export async function diagnose() {
  if (!(await hasTrope())) return missing();
  return { ok: true, backend: "trope-cua", command: [COMMAND, ...ARGS], message: "Trope CUA detected." };
}

export async function computerState(args = {}) {
  return await call(args.window_id ? "get_window_state" : "list_windows", args, args.timeout_ms);
}

export async function computerClick(args = {}) {
  return await call("click", args, args.timeout_ms);
}

export async function computerType(args = {}) {
  return await call("type", args, args.timeout_ms);
}

export async function computerKey(args = {}) {
  return await call("press_key", args, args.timeout_ms);
}

export async function computerScroll(args = {}) {
  return await call("scroll", args, args.timeout_ms);
}
