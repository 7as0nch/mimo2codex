import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, backupFile, readConfigTomlIfExists } from "./files.js";
import { configTomlPath } from "./paths.js";

export const BUILTIN_COMPUTER_USE_PLUGIN_ID = "mimo-computer-use";
export const COMPUTER_USE_SETTING_KEY = "plugins.mimo-computer-use.enabled";

export interface BuiltinPluginInfo {
  id: string;
  name: string;
  description: string;
  category: "computer-use";
  mcpServerName: string;
  pluginRoot: string;
  serverPath: string;
  docsPath: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function builtinComputerUsePlugin(): BuiltinPluginInfo {
  const root = path.join(repoRoot(), "plugins", BUILTIN_COMPUTER_USE_PLUGIN_ID);
  return {
    id: BUILTIN_COMPUTER_USE_PLUGIN_ID,
    name: "MiMo Computer Use",
    description:
      "Local MCP computer-use tools for MiMo, DeepSeek, and OpenAI-compatible models via the cross-platform Trope CUA adapter.",
    category: "computer-use",
    mcpServerName: BUILTIN_COMPUTER_USE_PLUGIN_ID,
    pluginRoot: root,
    serverPath: path.join(root, "server", "index.mjs"),
    docsPath: path.join(root, "docs", "quickstart.zh.md"),
  };
}

export function renderMcpServerBlock(plugin = builtinComputerUsePlugin()): string {
  const serverPath = toTomlString(plugin.serverPath);
  return `[mcp_servers.${plugin.mcpServerName}]
command = "node"
args = [${serverPath}]
startup_timeout_sec = 20

[mcp_servers.${plugin.mcpServerName}.env]
MIMO_COMPUTER_USE_BACKEND = "auto"`;
}

export function configHasMcpServer(config: string | null, serverName: string): boolean {
  if (!config) return false;
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*\\[mcp_servers\\.${escaped}\\]`, "m").test(config);
}

export function mergeMcpServerToml(
  existing: string | null,
  serverName: string,
  enabled: boolean,
  serverBlock: string
): string {
  const cleaned = removeMcpServerBlock(existing ?? "", serverName).trimEnd();
  if (!enabled) return cleaned ? `${cleaned}\n` : "";
  return [cleaned, serverBlock.trimEnd()].filter(Boolean).join("\n\n") + "\n";
}

export function applyMcpServerEnabled(enabled: boolean): {
  ok: true;
  path: string;
  enabled: boolean;
  backupPath: string | null;
  changed: boolean;
} {
  const plugin = builtinComputerUsePlugin();
  const filePath = configTomlPath();
  const before = readConfigTomlIfExists();
  if (!enabled && before === null) {
    return { ok: true, path: filePath, enabled, backupPath: null, changed: false };
  }
  const after = mergeMcpServerToml(
    before,
    plugin.mcpServerName,
    enabled,
    renderMcpServerBlock(plugin)
  );
  if ((before ?? "") === after) {
    return { ok: true, path: filePath, enabled, backupPath: null, changed: false };
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = before === null ? null : backupFile(filePath, Date.now());
  atomicWrite(filePath, after);
  return { ok: true, path: filePath, enabled, backupPath, changed: true };
}

export function readMcpPluginInstalled(): boolean {
  const plugin = builtinComputerUsePlugin();
  return existsSync(plugin.serverPath);
}

export function readQuickstartMarkdown(): string | null {
  const p = builtinComputerUsePlugin().docsPath;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export function pluginServerPath(): string {
  return builtinComputerUsePlugin().serverPath;
}

// Read the plugin's `[mcp_servers.<id>.env]` block from config.toml so that
// doctor/install/uninstall child processes run with the SAME backend selection
// (e.g. MIMO_COMPUTER_USE_BACKEND=trope + MIMO_COMPUTER_USE_TROPE_CMD) that
// Codex itself uses — otherwise detection would default to `auto` and report
// the wrong adapter. Only simple `KEY = "value"` lines are honored.
export function readPluginMcpEnvFromConfig(): Record<string, string> {
  const text = readConfigTomlIfExists();
  if (!text) return {};
  const plugin = builtinComputerUsePlugin();
  const wanted = `[mcp_servers.${plugin.mcpServerName}.env]`.replace(/\s+/g, "");
  const env: Record<string, string> = {};
  let inBlock = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      inBlock = trimmed.replace(/\s+/g, "") === wanted;
      continue;
    }
    if (!inBlock) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(trimmed);
    // TOML basic strings escape backslashes/quotes, so "C:\\Users" means
    // C:\Users — unescape before handing the value to the child process.
    if (m) env[m[1]] = m[2].replace(/\\(["\\nt])/g, (_s, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  return env;
}

export interface AdapterDoctor {
  adapterOk: boolean;
  backend: string | null;
  command: string[] | null;
  message: string | null;
  code: string | null;
  installPlan: unknown;
  raw?: unknown;
  error?: string;
}

// Run the plugin's own `--doctor` in a child node process and parse its JSON.
// This is how we detect whether the desktop backend (Trope CUA) is installed
// without duplicating the adapter-detection logic in the proxy.
export function runPluginDoctor(timeoutMs = 15_000): Promise<AdapterDoctor> {
  const serverPath = pluginServerPath();
  return new Promise((resolve) => {
    if (!existsSync(serverPath)) {
      resolve({
        adapterOk: false,
        backend: null,
        command: null,
        message: `plugin server not found at ${serverPath}`,
        code: "plugin_missing",
        installPlan: null,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(process.execPath, [serverPath, "--doctor"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...readPluginMcpEnvFromConfig() },
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result: AdapterDoctor): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) =>
      finish({
        adapterOk: false,
        backend: null,
        command: null,
        message: err.message,
        code: "spawn_failed",
        installPlan: null,
        error: err.message,
      })
    );
    child.on("close", () => {
      try {
        const json = JSON.parse(stdout) as {
          adapter?: string;
          diagnosis?: { ok?: boolean; backend?: string; command?: string[]; message?: string; code?: string };
          installPlan?: unknown;
        };
        const dx = json.diagnosis ?? {};
        finish({
          adapterOk: dx.ok === true,
          backend: dx.backend ?? json.adapter ?? null,
          command: Array.isArray(dx.command) ? dx.command : null,
          message: dx.message ?? null,
          code: dx.code ?? null,
          installPlan: json.installPlan ?? null,
          raw: json,
        });
      } catch {
        finish({
          adapterOk: false,
          backend: null,
          command: null,
          message: stderr.trim() || "failed to parse doctor output",
          code: "doctor_parse_failed",
          installPlan: null,
          error: stderr.trim() || stdout.trim().slice(0, 500),
        });
      }
    });
  });
}

// After a successful install, point Codex at the freshly built binary: ensure
// the plugin's [mcp_servers.*.env] block selects the trope backend and uses the
// given executable. No-op when the plugin block doesn't exist yet (plugin not
// enabled). Backs up before writing.
export function configureTropeBackendInConfig(exePath: string): { path: string; changed: boolean } {
  const filePath = configTomlPath();
  const before = readConfigTomlIfExists();
  if (before === null) return { path: filePath, changed: false };
  const plugin = builtinComputerUsePlugin();
  const envHeaderNorm = `[mcp_servers.${plugin.mcpServerName}.env]`.replace(/\s+/g, "");
  const desired: Record<string, string> = {
    MIMO_COMPUTER_USE_BACKEND: "trope",
    MIMO_COMPUTER_USE_TROPE_CMD: exePath,
    MIMO_COMPUTER_USE_TROPE_ARGS: "mcp",
  };
  const desiredLines = Object.entries(desired).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);

  const lines = before.replace(/\r\n/g, "\n").split("\n");
  const headerIdx = lines.findIndex((l) => l.trim().replace(/\s+/g, "") === envHeaderNorm);

  let after: string;
  if (headerIdx === -1) {
    // No env block — append one only if the server block exists.
    const serverHeaderNorm = `[mcp_servers.${plugin.mcpServerName}]`.replace(/\s+/g, "");
    if (!lines.some((l) => l.trim().replace(/\s+/g, "") === serverHeaderNorm)) {
      return { path: filePath, changed: false };
    }
    after = `${before.replace(/\s*$/, "")}\n\n[mcp_servers.${plugin.mcpServerName}.env]\n${desiredLines.join("\n")}\n`;
  } else {
    // Replace the desired keys inside the existing block (keep other keys).
    let end = headerIdx + 1;
    const kept: string[] = [];
    for (; end < lines.length; end++) {
      if (/^\s*\[/.test(lines[end])) break;
      const key = /^([A-Za-z0-9_]+)\s*=/.exec(lines[end].trim())?.[1];
      if (key && key in desired) continue;
      kept.push(lines[end]);
    }
    while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
    const block = [...kept, ...desiredLines];
    after = [...lines.slice(0, headerIdx + 1), ...block, ...lines.slice(end)].join("\n");
  }

  if (after === before) return { path: filePath, changed: false };
  backupFile(filePath, Date.now());
  atomicWrite(filePath, after);
  return { path: filePath, changed: true };
}

// On full uninstall, strip the hand-added MIMO_COMPUTER_USE_TROPE_CMD line from
// the plugin's [mcp_servers.*.env] block so config.toml returns to a clean
// state (backend etc. are left intact). Backs up before writing.
export function stripTropeCmdFromConfig(): { path: string; changed: boolean } {
  const filePath = configTomlPath();
  const before = readConfigTomlIfExists();
  if (before === null) return { path: filePath, changed: false };
  const after = before.replace(
    /^[^\S\r\n]*MIMO_COMPUTER_USE_TROPE_CMD[^\S\r\n]*=.*\r?\n?/gm,
    ""
  );
  if (after === before) return { path: filePath, changed: false };
  backupFile(filePath, Date.now());
  atomicWrite(filePath, after);
  return { path: filePath, changed: true };
}

function removeMcpServerBlock(text: string, serverName: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const exact = `[mcp_servers.${serverName}]`;
  const subPrefix = `[mcp_servers.${serverName}.`;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const isHeader = /^\s*\[/.test(line);
    if (isHeader) {
      const norm = line.trim().replace(/\s+/g, "");
      skipping = norm === exact || norm.startsWith(subPrefix);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}
