import { commandExists } from "../../server/lib/shell.mjs";
import { callExternalMcp } from "../../server/lib/external-mcp-client.mjs";

const ENV_COMMAND = process.env.MIMO_COMPUTER_USE_WINDOWS_MCP_CMD || "";
const ENV_ARGS = (process.env.MIMO_COMPUTER_USE_WINDOWS_MCP_ARGS || "")
  .split(/\s+/)
  .filter(Boolean);

async function resolveWindowsMcp() {
  if (ENV_COMMAND) {
    return {
      ok: await commandExists(ENV_COMMAND),
      command: ENV_COMMAND,
      args: ENV_ARGS.length ? ENV_ARGS : ["serve"],
      source: "env",
    };
  }
  if (await commandExists("windows-mcp")) {
    return { ok: true, command: "windows-mcp", args: ["serve"], source: "path" };
  }
  if (await commandExists("uvx")) {
    return { ok: true, command: "uvx", args: ["windows-mcp", "serve"], source: "uvx" };
  }
  return { ok: false, command: "windows-mcp", args: ["serve"], source: "missing" };
}

function missing() {
  return {
    ok: false,
    backend: "windows-mcp",
    platform: "win32",
    code: "adapter_missing",
    message:
      "Windows-MCP is not available. Install Windows-MCP, then ensure its command is on PATH or set MIMO_COMPUTER_USE_WINDOWS_MCP_CMD / MIMO_COMPUTER_USE_WINDOWS_MCP_ARGS.",
    install: {
      command: "uv tool install windows-mcp",
      fallback: "uvx windows-mcp serve",
      helper: "npm run install-adapter",
      docs: "https://github.com/CursorTouch/Windows-MCP",
    },
  };
}

async function call(tool, args, timeoutMs) {
  const runtime = await resolveWindowsMcp();
  if (!runtime.ok) return missing();
  const result = await callExternalMcp(runtime.command, runtime.args, tool, args, { timeoutMs });
  return {
    ok: result.ok,
    backend: "windows-mcp",
    command: [runtime.command, ...runtime.args],
    commandSource: runtime.source,
    tool,
    result: result.result ?? null,
    stderr: (result.stderr ?? "").trim(),
    message: result.ok
      ? "Windows-MCP tool completed."
      : `Windows-MCP tool failed: ${result.error}`,
  };
}

export async function diagnose() {
  const runtime = await resolveWindowsMcp();
  if (!runtime.ok) return missing();
  return {
    ok: true,
    backend: "windows-mcp",
    platform: "win32",
    command: [runtime.command, ...runtime.args],
    commandSource: runtime.source,
    message: "Windows-MCP command detected.",
  };
}

export async function computerState(args = {}) {
  return await call(args.include_tree === false ? "Screenshot" : "Snapshot", args, args.timeout_ms);
}

export async function computerClick(args = {}) {
  return await call("Click", args, args.timeout_ms);
}

export async function computerType(args = {}) {
  return await call("Type", args, args.timeout_ms);
}

export async function computerKey(args = {}) {
  return await call("Shortcut", args, args.timeout_ms);
}

export async function computerScroll(args = {}) {
  return await call("Scroll", args, args.timeout_ms);
}
