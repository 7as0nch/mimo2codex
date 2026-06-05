#!/usr/bin/env node
import { stdin, stdout, stderr, argv, platform } from "node:process";
import { MessageReader, writeMessage } from "./lib/framing.mjs";
import { chooseAdapter } from "./lib/adapters.mjs";
import { callTool, textResult, tools } from "./lib/tools.mjs";
import { adapterInstallPlan, installAdapter, uninstallAdapter, nutInstalled } from "./lib/installers.mjs";
import { overlayStatus, stopOverlay } from "./lib/overlay.mjs";

const serverInfo = { name: "mimo-computer-use", version: "0.2.0" };

async function doctor() {
  const adapter = chooseAdapter();
  const diagnosis = await adapter.module.diagnose();
  const installPlan = diagnosis?.ok === false ? adapterInstallPlan() : null;
  stdout.write(
    JSON.stringify(
      { server: serverInfo, platform, adapter: adapter.name, diagnosis, nutInstalled: nutInstalled(), overlay: overlayStatus(), installPlan },
      null,
      2
    )
  );
  stdout.write("\n");
}

async function installAdapterCli() {
  const withElectron = argv.includes("--with-electron");
  stdout.write("mimo-computer-use installer (pure Node)\n");
  stdout.write(`platform: ${platform}\n`);
  stdout.write(`electron overlay: ${withElectron ? "yes" : "no"}\n`);
  stdout.write("progress: installing dependencies...\n");
  const result = await installAdapter({
    confirm_install: true,
    force: true,
    with_electron: withElectron,
    timeout_ms: 10 * 60 * 1000,
    onProgress: (chunk) => stdout.write(chunk),
  });
  stdout.write("progress: installer finished\n");
  stdout.write(JSON.stringify({ result }, null, 2));
  stdout.write("\n");
  if (result.ok === false) process.exitCode = 1;
}

async function uninstallAdapterCli() {
  stdout.write("mimo-computer-use uninstaller\n");
  stdout.write("progress: removing Electron overlay runtime...\n");
  const result = await uninstallAdapter({ timeout_ms: 5 * 60 * 1000, onProgress: (chunk) => stdout.write(chunk) });
  stdout.write("progress: uninstaller finished\n");
  stdout.write(JSON.stringify({ result }, null, 2));
  stdout.write("\n");
  if (result.ok === false) process.exitCode = 1;
}

if (argv.includes("--doctor")) {
  await doctor();
  process.exit(0);
}
if (argv.includes("--install-adapter")) {
  await installAdapterCli();
  process.exit(process.exitCode ?? 0);
}
if (argv.includes("--uninstall-adapter")) {
  await uninstallAdapterCli();
  process.exit(process.exitCode ?? 0);
}

function respond(id, result) {
  writeMessage(stdout, { jsonrpc: "2.0", id, result });
}
function error(id, code, message) {
  writeMessage(stdout, { jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  if (!method) return;

  try {
    if (method === "initialize") {
      respond(id, { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "ping") {
      respond(id, {});
      return;
    }
    if (method === "tools/list") {
      respond(id, { tools });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const result = await callTool(name, args);
      respond(id, textResult(result));
      return;
    }
    error(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    stderr.write(`mimo-computer-use error: ${e?.stack ?? e}\n`);
    error(id, -32000, e?.message ?? String(e));
  }
}

// Tear down the Electron overlay child when Codex stops the MCP server, so we
// never leave an orphan transparent window on screen.
function shutdown() {
  stopOverlay();
}
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("exit", shutdown);

const reader = new MessageReader((message) => {
  void handle(message);
});
stdin.on("data", (chunk) => reader.push(chunk));
stdin.on("close", () => {
  shutdown();
  process.exit(0);
});
stdin.resume();
