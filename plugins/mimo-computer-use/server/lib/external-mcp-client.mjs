import { spawn } from "node:child_process";
import { MessageReader, writeMessage } from "./framing.mjs";

let nextId = 1;

export async function callExternalMcp(command, args, toolName, toolArgs, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  const pending = new Map();
  const reader = new MessageReader((message) => {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const slot = pending.get(message.id);
      if (slot) {
        pending.delete(message.id);
        slot(message);
      }
    }
  });
  child.stdout.on("data", (chunk) => reader.push(chunk));

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`external MCP request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      writeMessage(child.stdin, payload);
    });
  }

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mimo-computer-use", version: "0.1.0" },
    });
    if (init.error) throw new Error(init.error.message ?? JSON.stringify(init.error));
    writeMessage(child.stdin, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const call = await request("tools/call", { name: toolName, arguments: toolArgs ?? {} });
    if (call.error) throw new Error(call.error.message ?? JSON.stringify(call.error));
    return { ok: true, result: call.result, stderr };
  } catch (error) {
    return { ok: false, error: error.message, stderr };
  } finally {
    child.kill("SIGTERM");
  }
}
