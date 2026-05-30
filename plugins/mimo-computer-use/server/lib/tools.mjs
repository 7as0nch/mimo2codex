import { chooseAdapter, waitMs } from "./adapters.mjs";
import { adapterInstallPlan, installAdapter } from "./installers.mjs";

const coordinateProps = {
  x: { type: "number", description: "Screen x coordinate in pixels." },
  y: { type: "number", description: "Screen y coordinate in pixels." },
};

export const tools = [
  {
    name: "computer_state",
    description:
      "Inspect the current desktop/app state. Returns a JSON text summary and, when the backend provides one, a local screenshot path. Use this before clicking.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Optional app name or bundle/process hint." },
        window: { type: "string", description: "Optional window title hint." },
        include_tree: { type: "boolean", description: "Whether to include accessibility/element tree details when available." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_click",
    description:
      "Click a UI target. Prefer a target/element id from computer_state; coordinates are allowed when no target id is available.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Element id, label, or backend-specific target selector." },
        ...coordinateProps,
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button." },
        double: { type: "boolean", description: "Double-click instead of single-click." },
        app: { type: "string", description: "Optional app hint." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_type",
    description: "Type literal text into the focused field or selected target.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Literal text to type." },
        clear: { type: "boolean", description: "Clear the current field before typing when supported." },
        app: { type: "string", description: "Optional app hint." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      required: ["text"],
      additionalProperties: true,
    },
  },
  {
    name: "computer_key",
    description: "Press a key or shortcut, such as Enter, Escape, Cmd+L, Ctrl+C, or Alt+Tab.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Single key or shortcut combo." },
        combo: { type: "string", description: "Alias for key." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_scroll",
    description: "Scroll the active view or a coordinate target.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Backend-specific scroll amount or number of steps." },
        ...coordinateProps,
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_wait",
    description: "Wait for the desktop to settle. This is handled internally and does not call the OS adapter.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait, capped at 60000." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "computer_install_adapter",
    description:
      "Detect and install the platform adapter required by mimo-computer-use. Use only after explaining the third-party download plan to the user. Supports macOS Peekaboo via Homebrew and Windows-MCP via uv/uvx.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Return the install plan without running commands." },
        confirm_install: { type: "boolean", description: "Must be true before downloading/installing third-party software." },
        timeout_ms: { type: "number", description: "Installer timeout in milliseconds." },
      },
      additionalProperties: false,
    },
  },
];

export async function callTool(name, args = {}) {
  if (name === "computer_wait") return await waitMs(args.ms);
  if (name === "computer_install_adapter") {
    if (args.dry_run === true) return adapterInstallPlan();
    return await installAdapter(args);
  }
  const adapter = chooseAdapter();
  if (name === "computer_state") {
    if (!adapter.module.computerState) return await adapter.module.diagnose();
    return await adapter.module.computerState(args);
  }
  const handlers = {
    computer_click: "computerClick",
    computer_type: "computerType",
    computer_key: "computerKey",
    computer_scroll: "computerScroll",
  };
  const handler = handlers[name];
  if (!handler || typeof adapter.module[handler] !== "function") {
    return {
      ok: false,
      code: "unknown_tool",
      message: `Unknown mimo-computer-use tool: ${name}`,
    };
  }
  return await adapter.module[handler](args);
}

export function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError: payload?.ok === false,
  };
}
