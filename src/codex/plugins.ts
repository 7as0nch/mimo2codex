import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
