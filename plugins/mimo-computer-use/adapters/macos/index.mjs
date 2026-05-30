import { commandExists, runCommand } from "../../server/lib/shell.mjs";

const DEFAULT_CMD = process.env.MIMO_COMPUTER_USE_PEEKABOO_CMD || "peekaboo";

async function hasPeekaboo() {
  return await commandExists(DEFAULT_CMD);
}

function missing() {
  return {
    ok: false,
    backend: "peekaboo",
    platform: "darwin",
    code: "adapter_missing",
    message:
      "Peekaboo is not available. Install the Peekaboo CLI/MCP server, then ensure `peekaboo` is on PATH or set MIMO_COMPUTER_USE_PEEKABOO_CMD.",
    install: {
      command: "brew install steipete/tap/peekaboo",
      helper: "npm run install-adapter",
      note:
        "After installing, grant macOS Screen Recording and Accessibility permissions.",
      docs: "https://github.com/openclaw/Peekaboo",
    },
  };
}

async function runPeekaboo(args, timeoutMs) {
  if (!(await hasPeekaboo())) return missing();
  const result = await runCommand(DEFAULT_CMD, args, { timeoutMs });
  return {
    ok: result.ok,
    backend: "peekaboo",
    command: [DEFAULT_CMD, ...args],
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    message: result.ok
      ? "Peekaboo command completed."
      : "Peekaboo command failed. Check macOS Screen Recording / Accessibility permissions and the adapter stderr.",
  };
}

export async function diagnose() {
  if (!(await hasPeekaboo())) return missing();
  return {
    ok: true,
    backend: "peekaboo",
    platform: "darwin",
    message: "Peekaboo detected.",
    command: DEFAULT_CMD,
  };
}

export async function computerState(args = {}) {
  const cliArgs = ["see", "--json"];
  if (args.app) cliArgs.push("--app", String(args.app));
  if (args.window) cliArgs.push("--window-title", String(args.window));
  return await runPeekaboo(cliArgs, args.timeout_ms);
}

export async function computerClick(args = {}) {
  const cliArgs = ["click"];
  if (typeof args.x === "number" && typeof args.y === "number") {
    cliArgs.push("--coords", `${args.x},${args.y}`);
  } else if (args.target) {
    cliArgs.push("--on", String(args.target));
  }
  if (args.button) cliArgs.push("--button", String(args.button));
  if (args.double === true) cliArgs.push("--double");
  if (args.app) cliArgs.push("--app", String(args.app));
  return await runPeekaboo(cliArgs, args.timeout_ms);
}

export async function computerType(args = {}) {
  const cliArgs = ["type", "--text", String(args.text ?? "")];
  if (args.clear === true) cliArgs.push("--clear");
  if (args.app) cliArgs.push("--app", String(args.app));
  return await runPeekaboo(cliArgs, args.timeout_ms);
}

export async function computerKey(args = {}) {
  const combo = String(args.key ?? args.combo ?? "");
  const normalized = combo.replace(/\+/g, ",");
  const cliArgs = normalized.includes(",") ? ["hotkey", normalized] : ["press", normalized];
  return await runPeekaboo(cliArgs, args.timeout_ms);
}

export async function computerScroll(args = {}) {
  const cliArgs = ["scroll", "--direction", String(args.direction ?? "down")];
  if (args.amount != null) cliArgs.push("--amount", String(args.amount));
  if (typeof args.x === "number" && typeof args.y === "number") {
    cliArgs.push("--coords", `${args.x},${args.y}`);
  }
  return await runPeekaboo(cliArgs, args.timeout_ms);
}
