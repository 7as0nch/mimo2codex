import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatTool,
  ChatWebSearchTool,
  ChatToolChoice,
  ChatToolCall,
  ResponsesContentPart,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesMcpTool,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
} from "./types.js";
import { log } from "../util/log.js";

// Material a stripped image so the agent can pass the path to ocr.py.
// - data: URL  → decode, write to <dropDir>/cache/images/<sha1>.<ext>, return path
// - http(s):   → return as-is (ocr.py accepts URLs directly)
// - other:     → null (can't materialize)
// `dropDir` is typically cfg.dataDir; falls back to os.tmpdir()/mimo2codex-images.
function materializeStrippedImage(imageUrl: string, dropDir?: string): string | null {
  try {
    if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
      return imageUrl;
    }
    if (!imageUrl.startsWith("data:")) return null;
    const m = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(imageUrl);
    if (!m) return null;
    const mime = m[1] || "image/png";
    const isBase64 = imageUrl.startsWith(`data:${mime};base64,`) || /;base64,/.test(imageUrl);
    const payload = m[2];
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    const ext = mime.split("/")[1]?.split("+")[0] || "png";
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    const base = dropDir && dropDir.length > 0 ? dropDir : join(tmpdir(), "mimo2codex");
    const dir = join(base, "cache", "images");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${hash}.${ext}`);
    if (!existsSync(filePath)) writeFileSync(filePath, bytes);
    return filePath;
  } catch (e) {
    log.warn(`failed to materialize stripped image: ${(e as Error).message}`);
    return null;
  }
}

// Per MiMo docs (https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/multimodal-understanding/image-understanding),
// only `mimo-v2.5` and `mimo-v2-omni` (and *-omni* variants) accept image
// input. The other v2.5 variants (mimo-v2.5-pro, mimo-v2-flash, …) return
// 404 "No endpoints found that support image input" when given image_url parts.
export function modelSupportsImages(model: string): boolean {
  const base = model.toLowerCase();
  if (base.includes("omni")) return true;
  if (base === "mimo-v2.5") return true;
  return false;
}

function partsToChatContent(
  parts: ResponsesContentPart[] | string,
  ctx: { model: string; supportsImages: boolean; imageDropDir?: string }
): string | ChatContentPart[] {
  if (typeof parts === "string") return parts;

  const out: ChatContentPart[] = [];
  const droppedRefs: string[] = [];
  let droppedCount = 0;
  for (const p of parts) {
    if (p.type === "input_text" || p.type === "output_text") {
      // Defensive: Codex/clients sometimes send malformed text parts where
      // `text` is missing or non-string. Coerce to "" and drop empties —
      // MiMo's parser rejects parts where `text` is missing/empty with
      // "Param Incorrect: `text` is not set".
      const text = typeof p.text === "string" ? p.text : "";
      if (text.length === 0) continue;
      out.push({ type: "text", text });
    } else if (p.type === "input_image") {
      if (ctx.supportsImages) {
        out.push({ type: "image_url", image_url: { url: p.image_url, detail: p.detail } });
      } else {
        droppedCount++;
        const ref = materializeStrippedImage(p.image_url, ctx.imageDropDir);
        if (ref) droppedRefs.push(ref);
      }
    } else if (p.type === "input_file") {
      // MiMo doesn't natively support file inputs in chat completions.
      // Drop the part but leave the message intact.
      log.warn("dropped input_file part — MiMo chat API does not accept file inputs");
    }
    // Unknown part types (e.g. summary_text in some Responses variants) are
    // silently skipped — they'd cause MiMo to 400 if forwarded as-is.
  }

  if (droppedCount > 0) {
    log.warn(
      `dropped ${droppedCount} image part(s) — model "${ctx.model}" does not support image input (use mimo-v2.5 or mimo-v2-omni for vision); materialized ${droppedRefs.length} to disk`
    );
    // Tell the agent BOTH that images were stripped AND where to find them
    // so it can OCR without asking the user for a path. Codex / DS / Qwen
    // etc. read this and route to mimoskill/scripts/ocr.py per AGENTS.md.
    const refList = droppedRefs.length > 0
      ? droppedRefs.map((r, i) => `  ${i + 1}. ${r}`).join("\n")
      : "  (could not materialize image — unknown URL form)";
    const plural = droppedCount > 1 ? "s" : "";
    out.push({
      type: "text",
      text:
        `[${droppedCount} image attachment${plural} omitted because the active model can't ingest images.\n` +
        `The proxy materialized them to disk so you can OCR / describe without asking the user for a path:\n` +
        refList +
        `\nTo extract text or describe, run:\n` +
        `  python3 mimoskill/scripts/ocr.py <path-from-above>\n` +
        `Engine auto-select (zero-key): mimo (if MIMO_API_KEY set) > tesseract (if installed, --mode text) > pollinations.\n` +
        `If pollinations is unreachable (e.g. mainland China), install tesseract once for offline OCR:\n` +
        `  brew install tesseract tesseract-lang  /  apt install tesseract-ocr tesseract-ocr-chi-sim\n` +
        `Or switch the chat model to mimo-v2.5 / mimo-v2-omni to see images directly.]`,
    });
  }

  // MiMo's image-understanding API REQUIRES at least one `text` part in the
  // content array whenever `image_url` parts are present. Otherwise it 400s
  // with "Param Incorrect: `text` is not set" (yes, even though OpenAI's
  // chat API doesn't require this). Codex sometimes sends image-only user
  // messages (paste-and-send), so we add an empty fallback to satisfy the
  // schema. The image alone is usually enough context for the model.
  const hasImage = out.some((p) => p.type === "image_url");
  const hasText = out.some((p) => p.type === "text");
  if (hasImage && !hasText) {
    out.push({ type: "text", text: " " });
  }

  // If the message is purely text, collapse to a string for cleaner upstream payloads.
  if (out.length > 0 && out.every((p) => p.type === "text")) {
    return out.map((p) => (p as { text: string }).text).join("");
  }
  if (out.length === 0) return "";
  return out;
}

// Flatten a function_call_output.output into a plain string suitable for the
// `tool` role's `content` field. Codex/Responses can send an array of content
// parts here when a tool returned images (image_gen, mimoskill image gen,
// etc.). Chat Completions tool messages only accept a string content across
// all upstreams (OpenAI's array extension isn't supported by MiMo / DeepSeek /
// most third-party providers, and DeepSeek explicitly 400s with
// "unknown variant `input_image`, expected `text`"). So we always textify and
// replace images with a one-line placeholder.
function toolOutputToString(output: ResponsesFunctionCallOutputItem["output"]): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  const chunks: string[] = [];
  let droppedImages = 0;
  for (const p of output) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_text" || p.type === "output_text") {
      const text = typeof p.text === "string" ? p.text : "";
      if (text.length > 0) chunks.push(text);
    } else if (p.type === "input_image") {
      droppedImages++;
    }
    // input_file and unknown parts are silently dropped.
  }
  if (droppedImages > 0) {
    log.warn(
      `dropped ${droppedImages} image part(s) from tool output — Chat Completions tool messages cannot carry images`
    );
    chunks.push(
      `[${droppedImages} image attachment${droppedImages > 1 ? "s" : ""} omitted from tool output: this chat backend cannot ingest images in tool results.]`
    );
  }
  return chunks.join("");
}

function messageItemToChat(
  item: ResponsesMessageItem,
  ctx: { model: string; supportsImages: boolean; imageDropDir?: string }
): ChatMessage {
  const role = item.role === "developer" ? "system" : item.role;
  const content = partsToChatContent(item.content, ctx);
  if (role === "assistant") {
    return { role: "assistant", content: typeof content === "string" ? content : "" };
  }
  return { role, content };
}

// Schema for Codex's `local_shell` builtin tool, mapped to a regular function
// tool that MiMo (and any chat-completions-only provider) can understand.
// Codex registers handlers for both `local_shell` (builtin) and `shell`
// (function), so emitting `shell` tool_calls back to it just works.
const LOCAL_SHELL_FN: ChatTool = {
  type: "function",
  function: {
    name: "shell",
    description:
      "Execute a shell command on the local machine. Returns stdout, stderr and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          description:
            "Argv array, e.g. [\"ls\", \"-la\"]. The first element is the program; remaining elements are arguments.",
        },
        workdir: {
          type: "string",
          description: "Working directory to run the command in (optional).",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (optional, default 30000).",
        },
      },
      required: ["command"],
    },
    // strict 故意省略：MiMo 后端使用 Pydantic 严格校验，会拒绝
    // `strict: null`（报错 `Input should be a valid boolean`）。OpenAI 规范里
    // strict 本就是 optional，省略与不严格 schema 行为等价。见 issue #11。
  },
};

// Tools that exist server-side at OpenAI but have no equivalent at MiMo.
// We drop them silently (only log at debug level) — there's nothing a chat
// completions provider can do with them. NOTE: web_search and
// web_search_preview are NOT in this list — MiMo has its own native
// web_search builtin (requires the Web Search Plugin to be activated in
// the MiMo console: https://platform.xiaomimimo.com/#/console/plugin).
const SERVER_SIDE_TOOLS = new Set([
  "code_interpreter",
  "file_search",
  "image_generation",
  "computer_use_preview",
  "computer_use",
]);

// Track tool types we've already warned about so we don't spam the log on
// every request (Codex re-sends the full tool list each turn).
const warnedTypes = new Set<string>();
function warnOnce(toolType: string, msg: string): void {
  if (warnedTypes.has(toolType)) return;
  warnedTypes.add(toolType);
  log.warn(msg);
}

export interface ReqToChatOpts {
  // Add `thinking: {type: "disabled"}` to the chat body — MiMo skips its
  // reasoning mode, which makes the model less likely to "narrate" without
  // calling tools. Useful for agentic / coding workflows.
  disableThinking?: boolean;
  // Override Codex's `parallel_tool_calls: false` to true. Codex defaults to
  // serial tool calls (one per round-trip); for MiMo this can cause the model
  // to give up after 3-4 explore rounds without ever calling apply_patch.
  forceParallelToolCalls?: boolean;
  // Translate Codex's web_search/web_search_preview to MiMo's web_search
  // builtin. Default OFF — MiMo's Web Search Plugin is separately billed and
  // returns 400 "webSearchEnabled is false" if not activated.
  enableWebSearch?: boolean;
  // Directory where stripped images are materialized for non-vision models.
  // Typically cfg.dataDir; falls back to os.tmpdir()/mimo2codex when unset.
  // Lets the agent OCR pasted images without asking the user for a path.
  imageDropDir?: string;
  // 兜底注入 reasoning_effort="high"：当 Codex 没在请求里传 reasoning.effort 时，主动让
  // 上游真高强度思考（mimo/deepseek/sensenova/Kimi 等都接受这字段）。**默认关**，因为
  // 副作用明显（多花 token、所有简单请求也走思考）—— admin UI / CLI 显式打开才生效。
  // disableThinking=true 时此开关无效（关思考路径接管）。
  forceHighEffort?: boolean;
  // The model id that's *actually* going to upstream (after admin runtime
  // override / alias / provider defaultModel fallback). When provided, this
  // is what capability checks (vision, etc.) consult — NOT `req.model`, which
  // is the client's literal that may not match the upstream model.
  //
  // Example: Codex sends `mimo-v2.5-pro` (no vision), but the admin has it
  // aliased to upstream `mimo-v2.5` (vision). The image must NOT be stripped
  // — the upstream can handle it.
  //
  // Omit / leave undefined → fall back to `req.model` (backward-compatible).
  upstreamModel?: string;
}

// Returns one or more ChatTools (a `namespace` wrapper can expand to many),
// or null if the tool is unrecognized / unsupported.
function toolToChat(t: ResponsesTool, opts: ReqToChatOpts): ChatTool | ChatTool[] | null {
  // 1. Standard OpenAI function tool — pass through.
  if (t.type === "function") {
    const ft = t as { type: "function"; name?: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean | null };
    if (!ft.name) {
      log.debug("dropping function tool with no name");
      return null;
    }
    // issue #11: 只在 strict 是显式 boolean 时才写入字段。Codex Desktop 经常会
    // 发 `strict: null`（或不传 strict）；之前的 `ft.strict ?? null` 把这两种
    // 情况都序列化为 `strict: null` 发给上游，而 MiMo 的 Pydantic schema 拒绝
    // null → 400 "Input should be a valid boolean"。省略字段对齐 OpenAI 规范
    // （strict 是 optional），同时兼容所有严格 OpenAI 兼容上游。
    const fn: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } = {
      name: ft.name,
      description: ft.description,
      parameters: ft.parameters,
    };
    if (typeof ft.strict === "boolean") fn.strict = ft.strict;
    return { type: "function", function: fn };
  }

  // 2. Codex's `local_shell` builtin → emit as a regular `shell` function tool
  //    with the canonical schema (see LOCAL_SHELL_FN above). Codex's tool router
  //    accepts both names.
  if (t.type === "local_shell") {
    return LOCAL_SHELL_FN;
  }

  // 2.5. OpenAI's `web_search` / `web_search_preview` → MiMo's native `web_search`.
  //      Forwarded by default; the server passes enableWebSearch: true. The
  //      option is kept for tests and for any future "off switch". If MiMo
  //      rejects with `webSearchEnabled is false` (plugin not activated for
  //      that account), mimoClient surfaces a clear error to the user — we do
  //      NOT silently retry, so users see the real configuration issue.
  if (t.type === "web_search" || t.type === "web_search_preview") {
    if (!opts.enableWebSearch) {
      return null;
    }
    const w = t as {
      user_location?: ChatWebSearchTool["user_location"];
      max_keyword?: number;
      force_search?: boolean;
      limit?: number;
    };
    const tool: ChatWebSearchTool = { type: "web_search" };
    if (w.user_location) tool.user_location = w.user_location;
    if (typeof w.max_keyword === "number") tool.max_keyword = w.max_keyword;
    if (typeof w.force_search === "boolean") tool.force_search = w.force_search;
    if (typeof w.limit === "number") tool.limit = w.limit;
    return tool;
  }

  // 3. Codex / OpenAI `custom` tool — freeform tool, often used for grammar-
  //    constrained outputs. We can't enforce the grammar at MiMo, but we can
  //    forward the name + description as a parameter-less function so the
  //    model can still call it. Format here:
  //      { type: "custom", name, description?, format?: { type: "grammar" | "text", ... } }
  if (t.type === "custom") {
    const ct = t as { name?: string; description?: string; format?: { type?: string } };
    if (!ct.name) {
      log.debug("dropping custom tool with no name");
      return null;
    }
    const formatType = ct.format?.type;
    const desc =
      (ct.description ?? "") +
      (formatType
        ? ` (originally a "${formatType}"-format custom tool; output should follow that format).`
        : "");
    return {
      type: "function",
      function: {
        name: ct.name,
        description: desc.trim() || undefined,
        // Permissive schema since we don't know the original input shape.
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Input text for the tool.",
            },
          },
          additionalProperties: true,
        },
        // strict 故意省略，见 issue #11 / 上方 function 工具透传分支注释。
      },
    };
  }

  // 4. `namespace` wrapper — Codex bundles MCP / grouped tools under this. Shape
  //    we've seen in the wild:
  //       { type: "namespace", name?: string, tools?: Tool[] }
  //    Recurse into nested tools and flatten. If there's no nested array, drop.
  //    Tool names stay unprefixed; the namespace is re-attached in the response
  //    translation (respToResponses / streamToSse) so Codex Desktop can route.
  if (t.type === "namespace") {
    const ns = t as { name?: string; tools?: ResponsesTool[] };
    if (!Array.isArray(ns.tools) || ns.tools.length === 0) {
      log.debug(
        `dropping "namespace" tool ${ns.name ? `"${ns.name}"` : ""} with no nested tools`
      );
      return null;
    }
    const nested: ChatTool[] = [];
    for (const inner of ns.tools) {
      const r = toolToChat(inner, opts);
      if (Array.isArray(r)) nested.push(...r);
      else if (r) nested.push(r);
    }
    return nested.length > 0 ? nested : null;
  }

  // 5. Server-side tools that only OpenAI/Azure can fulfill — silently drop.
  if (SERVER_SIDE_TOOLS.has(t.type)) {
    log.debug(
      `dropping server-side tool "${t.type}" — no MiMo equivalent (only OpenAI/Azure can fulfill)`
    );
    return null;
  }

  // 6. OpenAI Responses-API `mcp` tool — Codex Desktop connector plugins and
  //    user-configured remote MCP servers both share this type, distinguished
  //    by `connector_id` (first-party, OpenAI-hosted) vs `server_url` (BYO).
  //    Chat-Completions providers (MiMo / DeepSeek / SenseNova / ...) do not
  //    implement OpenAI's MCP runtime, so we drop these — but the drop must
  //    be visible and kind-classified so users can diagnose. See issue #39 +
  //    doc/connector-plugins.md.
  if (t.type === "mcp") {
    return mcpToolToChat(t as ResponsesMcpTool);
  }

  // 7. Codex Desktop's `tool_search` builtin (issue #41) — deferred-tool
  //    discovery via BM25 over tool metadata. Shape is essentially a
  //    function tool (`description` + `parameters`) with `execution: "client"`,
  //    meaning Codex Desktop handles the call locally and returns the
  //    matching tools in the next turn. We translate it to a regular
  //    `function` tool with name="tool_search" so upstream models can
  //    invoke it; the function_call comes back, Codex Desktop executes
  //    client-side, and the discovered tools enter the next request's
  //    tools[] naturally.
  if (t.type === "tool_search") {
    const ts = t as {
      description?: string;
      parameters?: Record<string, unknown>;
    };
    const fn: { name: string; description?: string; parameters?: Record<string, unknown> } = {
      name: "tool_search",
    };
    if (typeof ts.description === "string") fn.description = ts.description;
    if (ts.parameters && typeof ts.parameters === "object") fn.parameters = ts.parameters;
    return { type: "function", function: fn };
  }

  // 8. Truly unknown — keep the WARN short so non-technical users don't get
  //    spooked; the (redacted) payload goes to DEBUG only. Set
  //    MIMO2CODEX_VERBOSE=1 to surface it when reporting an issue.
  warnOnce(
    t.type,
    `dropping unknown tool type "${t.type}" — harmless; if this should be supported, set MIMO2CODEX_VERBOSE=1 and report at https://github.com/7as0nch/mimo2codex/issues`
  );
  log.debug(`unknown tool "${t.type}" payload: ${JSON.stringify(redactToolPayload(t))}`);
  return null;
}

// MCP / Codex-Desktop-connector handling. Three kinds, three log levels:
//   - connector_id (first-party):  silent → DEBUG. The advisory system note
//     injected at the call site already tells the upstream model the tool is
//     unavailable, so a WARN would be redundant log noise for end users.
//   - server_url (remote MCP):     WARN. Phase B bridging not yet implemented,
//     so the user genuinely loses the tool without compensating UX. Short msg.
//   - neither field set:           WARN. Edge case, kept terse.
function mcpToolToChat(t: ResponsesMcpTool): ChatTool | ChatTool[] | null {
  const label = t.server_label ?? t.connector_id ?? t.server_url ?? "(unnamed)";
  if (t.connector_id) {
    log.debug(
      `mcp first-party connector "${label}" dropped — advisory system note injected to upstream model. See doc/connector-plugins.md.`
    );
    return null;
  }
  if (t.server_url) {
    warnOnce(
      `mcp:remote-mcp:${label}`,
      `remote MCP tool "${label}" dropped — bridging not yet supported. See doc/connector-plugins.md.`
    );
    return null;
  }
  warnOnce(
    `mcp:unknown:${label}`,
    `mcp tool "${label}" dropped — neither connector_id nor server_url set.`
  );
  return null;
}

// Phase C of issue #39: scan req.tools for `mcp + connector_id` entries
// (first-party Codex Desktop connector plugins — GitHub / Canva / HeyGen /
// Dropbox / Gmail / Google Drive / ...) and return their user-visible labels.
// Used to build the system-prompt advisory note injected into the chat
// request so the upstream model knows the connectors aren't actually callable.
function collectFirstPartyConnectorLabels(tools: ResponsesTool[]): string[] {
  const labels: string[] = [];
  for (const t of tools) {
    if ((t as { type?: string }).type !== "mcp") continue;
    const m = t as ResponsesMcpTool;
    if (typeof m.connector_id !== "string" || m.connector_id.length === 0) continue;
    labels.push(m.server_label ?? m.connector_id);
  }
  return labels;
}

// Known first-party connectors → suggested CLI equivalent. Matched on
// substrings (case-insensitive) of the label so e.g. "GitHub", "github",
// "GitHub-something" all map to `gh`. The model gets a concrete fallback
// instead of vague advice.
const CONNECTOR_CLI_HINTS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /github/i, hint: "`gh` (GitHub CLI: https://cli.github.com)" },
  { pattern: /(gmail|google[\s_-]?drive|google[\s_-]?docs)/i, hint: "`rclone` or Google's official CLI tools" },
  { pattern: /dropbox/i, hint: "`rclone` or the `dropbox` CLI" },
  { pattern: /(canva|heygen)/i, hint: "their REST API via `curl` (user provides their own API key)" },
];

function buildConnectorAdvisoryNote(labels: string[]): string {
  const list = labels.map((l) => `"${l}"`).join(", ");
  const hintLines: string[] = [];
  const seenHints = new Set<string>();
  for (const label of labels) {
    for (const { pattern, hint } of CONNECTOR_CLI_HINTS) {
      if (pattern.test(label) && !seenHints.has(hint)) {
        seenHints.add(hint);
        hintLines.push(`  - for ${label}: ${hint}`);
      }
    }
  }
  const hintBlock =
    hintLines.length > 0
      ? `\nSuggested command-line alternatives:\n${hintLines.join("\n")}`
      : "";
  return (
    `Note from the mimo2codex proxy: the user has the following Codex Desktop connector plugin(s) ` +
    `enabled — ${list} — but these are NOT available through this proxy. ` +
    `The upstream provider does not implement OpenAI's MCP runtime, so no tool exists for them. ` +
    `If the user requests functionality that would normally use one of these connectors:\n` +
    `1. Tell the user the connector is unavailable through mimo2codex.\n` +
    `2. Suggest they either disable it in Codex Desktop → Settings → Plugins, or have you run a shell command-line equivalent (you have the shell tool available for this).\n` +
    `3. Do not pretend to call the connector — there is no tool available for it, and any attempted call will fail.${hintBlock}\n` +
    `If the user's actual request can be handled with the shell tool alone, proceed normally without mentioning this note.`
  );
}

// Keys that must never reach the log verbatim. Matched case-insensitively
// because some upstreams capitalize differently (Authorization vs authorization,
// apiKey vs api_key vs API_KEY). Applied recursively into nested objects and
// arrays so deeply-buried OAuth tokens still get scrubbed.
const SECRET_KEY_RE =
  /^(authorization|api[_-]?key|token|secret|password|access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer)$/i;
function redactToolPayload(t: unknown): unknown {
  if (t === null || typeof t !== "object") return t;
  if (Array.isArray(t)) return t.map(redactToolPayload);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? "***" : redactToolPayload(v);
  }
  return out;
}

// Defensive dedup at the tool merge site (issue #20).
//
// Codex CLI / Desktop builds (especially newer versions / DeX) sometimes send
// the same tool name twice — e.g. a top-level `function` tool `_fetch`
// alongside a `namespace`-wrapped `_fetch` that flattens to a second copy of
// the same name. MiMo (and most strict OpenAI-compatible upstreams) reject
// the merged tools list with
//   400 Param Incorrect: tools contains duplicate names: _fetch
// even though both definitions came from the client. This proxy has no way
// to tell which copy is "right," so we keep the first occurrence (typical
// client intent: namespace-wrapped versions come later and shadow the
// builtin) and drop the rest with a one-shot warn so users notice.
//
// Dedup keys:
//   - function tools  → "fn:<function.name>"
//   - builtin tools   → "builtin:<type>" (web_search, code_interpreter, ...)
// A function named "web_search" and a builtin `web_search` tool will NOT
// collide — they live in different namespaces — which matches how the
// upstream validates the field too.
function dedupeToolsByName(tools: ChatTool[]): ChatTool[] {
  const seen = new Set<string>();
  const out: ChatTool[] = [];
  for (const t of tools) {
    const key =
      t.type === "function"
        ? `fn:${t.function.name}`
        : `builtin:${t.type}`;
    if (seen.has(key)) {
      const label = key.replace(/^(fn|builtin):/, "");
      log.warn(
        `dropping duplicate tool "${label}" — client sent it more than once. ` +
          "This is typically a Codex CLI / Desktop bug (issue #20); the dedupe is defensive."
      );
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Defensive sanitizer for historical `function_call.arguments`.
//
// Bug context: Codex persists `tool_calls[].function.arguments` verbatim from
// whatever `response.function_call_arguments.done` emitted in the previous turn.
// If the upstream SSE stream finished mid tool-call (finish_reason="length",
// network truncation, client cancel, thinking-budget exhaustion …) the
// `arguments` string is **incomplete JSON**. From that point on, every
// subsequent request in the same Codex session carries the bad tool-call in
// its history, and strict upstreams (MiMo / DeepSeek / SenseNova …) reject
// the request body with a JSON parse error such as
//   400 BadRequest: unexpected end of data: line 1 column 46 (char 45)
// pointing at the `arguments` field they tried to re-parse. The session
// becomes unrecoverable until the user starts a new chat.
//
// Fix: on the way out, validate that `arguments` parses as JSON. If not,
// replace with "{}" so the request reaches the upstream intact. Dropping the
// whole tool-call would orphan its matching `tool` message (and break the
// invariants maintained by removeOrphanToolMessages / ensureToolCallsHaveOutputs);
// nulling just the arguments preserves the message-pair structure while
// neutralizing the poison. The model loses visibility into what that
// historical call's arguments were, but the conversation can continue.
function sanitizeFunctionCallArguments(raw: unknown, name: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "{}";
  }
  try {
    JSON.parse(raw);
    return raw;
  } catch (err) {
    log.warn(
      `salvaging malformed historical tool_call arguments → "{}" — name="${name ?? "?"}" len=${raw.length} ` +
        `parse_err="${(err as Error).message}" preview=${JSON.stringify(raw.slice(0, 80))}`
    );
    return "{}";
  }
}

function toolChoiceToChat(tc: ResponsesToolChoice | undefined): ChatToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (typeof tc === "string") return tc;
  if (tc.type === "function") {
    const name = tc.function?.name ?? tc.name;
    if (!name) return undefined;
    return { type: "function", function: { name } };
  }
  return undefined;
}

interface AssemblyState {
  pendingReasoning: string | null;
  pendingToolCalls: ChatToolCall[];
  pendingAssistantText: string | null;
}

function flushAssistant(messages: ChatMessage[], state: AssemblyState): void {
  const hasReasoning = state.pendingReasoning !== null;
  const hasTools = state.pendingToolCalls.length > 0;
  const hasText = state.pendingAssistantText !== null;
  if (!hasReasoning && !hasTools && !hasText) return;

  // OpenAI Chat Completions: assistant.content 在 tool_calls 存在时是可选的，
  // 但显式 `null` 会被部分严格上游（DeepSeek V4 — issue #29）当成"两个字段都
  // 没有"，于是 400 "Invalid assistant message: content or tool_calls must be
  // set"。所以 tool_calls 存在时直接不带 content 字段；reasoning-only 的
  // 兜底回合（无 text 无 tools）补一个空字符串以满足"content 或 tool_calls
  // 必须存在"。
  const msg: ChatMessage = { role: "assistant" };
  if (hasText) {
    msg.content = state.pendingAssistantText;
  } else if (!hasTools) {
    msg.content = "";
  }
  if (hasTools) msg.tool_calls = state.pendingToolCalls;
  if (hasReasoning) msg.reasoning_content = state.pendingReasoning;
  messages.push(msg);

  state.pendingReasoning = null;
  state.pendingToolCalls = [];
  state.pendingAssistantText = null;
}

function inputItemsToMessages(
  items: ResponsesInputItem[],
  ctx: { model: string; supportsImages: boolean; imageDropDir?: string }
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const state: AssemblyState = {
    pendingReasoning: null,
    pendingToolCalls: [],
    pendingAssistantText: null,
  };

  for (const rawItem of items) {
    // Compatibility with Chat-Completions-shaped probes (cc-switch test
    // connection, raw OpenAI SDK requests sent at the wrong endpoint, etc.):
    // `{role, content: string}` with NO `type` field. Real Codex always sends
    // `{type: "message", role, content: [...]}`. Promote the simple shape to
    // a message item so we don't silently drop it and produce empty messages.
    let item: ResponsesInputItem = rawItem;
    if (item && typeof item === "object" && !("type" in item)) {
      const legacy = item as unknown as { role?: string; content?: unknown };
      if (typeof legacy.role === "string") {
        const text =
          typeof legacy.content === "string"
            ? legacy.content
            : Array.isArray(legacy.content)
              ? legacy.content
                  .map((p: unknown) => {
                    if (typeof p === "string") return p;
                    if (p && typeof p === "object" && "text" in p)
                      return String((p as { text: unknown }).text ?? "");
                    return "";
                  })
                  .join("")
              : "";
        item = {
          type: "message",
          role: legacy.role as "user" | "system" | "developer" | "assistant",
          content: [
            { type: legacy.role === "assistant" ? "output_text" : "input_text", text },
          ],
        } as ResponsesInputItem;
      }
    }

    switch (item.type) {
      case "message": {
        if (item.role === "assistant") {
          // Buffer assistant text into pending, but DO NOT flush yet — any
          // following function_call items (same agent turn) need to merge into
          // ONE assistant message alongside the text and reasoning_content.
          // Splitting them would leave the tool-call message without reasoning,
          // which DeepSeek V4 thinking mode rejects with
          // "The reasoning_content in the thinking mode must be passed back".
          //
          // Edge case: two assistant messages back-to-back (rare). Flush the
          // previous one first so we don't drop its text.
          if (state.pendingAssistantText !== null) {
            flushAssistant(out, state);
          }
          const content = partsToChatContent(item.content, ctx);
          state.pendingAssistantText =
            typeof content === "string" ? content : "";
        } else {
          flushAssistant(out, state);
          out.push(messageItemToChat(item, ctx));
        }
        break;
      }
      case "reasoning": {
        // Prefer `encrypted_content` — that's where respToResponses /
        // streamToSse pin the FULL reasoning trace (Codex echoes it
        // back verbatim across turns, summary may be empty under
        // --no-reasoning). Fall back to summary text for compatibility
        // with reasoning items emitted by other clients / older
        // mimo2codex versions.
        let text = "";
        if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
          text = item.encrypted_content;
        } else {
          text = item.summary
            .filter((s) => s.type === "summary_text")
            .map((s) => s.text)
            .join("");
        }
        // If an assistant turn is already mid-assembly (pending tool_calls
        // or text), fold this reasoning into the SAME message rather than
        // flushing. Otherwise the resulting wire shape would be:
        //   assistant(tool_calls=[A]) | assistant(reasoning_content=...) | tool(A)
        // which violates the Chat Completions invariant "an assistant
        // message with tool_calls must be IMMEDIATELY followed by tool
        // messages" — DeepSeek V4 enforces this and 400s with
        // "insufficient tool messages following tool_calls message". Codex
        // emits reasoning items at varying positions (sometimes before,
        // sometimes between, sometimes after function_calls within a
        // single turn), so we must absorb wherever they land.
        if (state.pendingToolCalls.length > 0 || state.pendingAssistantText !== null) {
          state.pendingReasoning =
            state.pendingReasoning !== null ? state.pendingReasoning + text : text;
        } else {
          flushAssistant(out, state);
          state.pendingReasoning = text;
        }
        break;
      }
      case "function_call": {
        state.pendingToolCalls.push({
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: sanitizeFunctionCallArguments(item.arguments, item.name),
          },
        });
        break;
      }
      case "function_call_output": {
        flushAssistant(out, state);
        out.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: toolOutputToString(item.output),
        });
        break;
      }
    }
  }
  flushAssistant(out, state);
  removeOrphanToolMessages(out);
  ensureToolCallsHaveOutputs(out);
  return out;
}

// Reverse direction of ensureToolCallsHaveOutputs: drop orphan
// `{role: "tool"}` messages whose `tool_call_id` has NO preceding
// assistant.tool_calls in scope.
//
// Triggered when Codex session state desyncs:
//   - user interrupts a parallel-tool-call turn mid-flight
//   - partial replay after a crash / undo / redo
//   - Codex internal bug that drops the parent assistant.tool_calls
//     while keeping its tool outputs (openai/codex#8479)
//
// Without this scrub, DeepSeek V4 400s with:
//   "Messages with role 'tool' must be a response to a preceding message
//    with 'tool_calls'"
// and the whole session becomes unrecoverable
// (mimo2codex#8 — same symptom).
//
// Scope rule: a tool message is valid only when it directly follows an
// assistant message that declared its tool_call_id. Any other message
// type (user / system / etc.) resets the validity window — a tool
// message that appears after a user message but before any
// assistant.tool_calls is an orphan and must be removed.
function removeOrphanToolMessages(messages: ChatMessage[]): void {
  let validIds: Set<string> | null = null;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "assistant") {
      validIds =
        m.tool_calls && m.tool_calls.length > 0
          ? new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean) as string[])
          : null;
      i++;
    } else if (m.role === "tool") {
      if (validIds && m.tool_call_id && validIds.has(m.tool_call_id)) {
        i++;
      } else {
        log.warn(
          `dropped orphan tool message: tool_call_id=${m.tool_call_id} (no preceding assistant.tool_calls in scope)`,
        );
        messages.splice(i, 1);
        // do NOT increment i — splice shifted next element into position i
      }
    } else {
      // user / system / other — reset tool-receiving window
      validIds = null;
      i++;
    }
  }
}

// Defensive backstop: every assistant message with `tool_calls` must be
// followed by one `{role: "tool", tool_call_id}` per call before any other
// message. If the input is missing a tool output (cancelled turn, dropped
// output, Codex bug), synthesize a placeholder tool message so we still
// emit a body the upstream accepts. DeepSeek V4 strictly enforces this
// invariant and 400s otherwise.
function ensureToolCallsHaveOutputs(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;

    const seen = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const tcid = messages[j].tool_call_id;
      if (tcid) seen.add(tcid);
      j++;
    }
    const missing = m.tool_calls
      .map((tc) => tc.id)
      .filter((id) => !seen.has(id));
    if (missing.length === 0) continue;

    const placeholders: ChatMessage[] = missing.map((id) => ({
      role: "tool",
      tool_call_id: id,
      content: "[tool output missing — no function_call_output was provided for this call_id]",
    }));
    messages.splice(j, 0, ...placeholders);
    // Skip past the newly-inserted placeholders to avoid re-scanning them.
    i = j + placeholders.length - 1;
  }
}

export function reqToChat(req: ResponsesRequest, opts: ReqToChatOpts = {}): ChatRequest {
  const messages: ChatMessage[] = [];
  // Capability checks (vision, etc.) follow the upstream model — what actually
  // receives the request — not the client literal. Falls back to req.model so
  // existing callers keep their current behavior.
  const effectiveModel = opts.upstreamModel ?? req.model;
  const ctx = {
    model: effectiveModel,
    supportsImages: modelSupportsImages(effectiveModel),
    imageDropDir: opts.imageDropDir,
  };

  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const m of inputItemsToMessages(req.input, ctx)) {
      messages.push(m);
    }
  }

  const chat: ChatRequest = {
    model: req.model,
    messages,
    stream: req.stream ?? false,
  };
  if (chat.stream) {
    chat.stream_options = { include_usage: true };
  }

  if (req.tools && req.tools.length > 0) {
    const mapped: ChatTool[] = [];
    let droppedCount = 0;
    for (const t of req.tools) {
      const r = toolToChat(t, opts);
      if (Array.isArray(r)) {
        if (r.length === 0) droppedCount++;
        else mapped.push(...r);
      } else if (r) {
        mapped.push(r);
      } else {
        droppedCount++;
      }
    }
    // Note: a previous version emitted a summary WARN when every tool got
    // dropped. Removed — Phase C's advisory system note handles connector
    // cases, single per-type WARNs handle the rest. The summary was log
    // noise for non-technical users.
    if (droppedCount > 0 && mapped.length === 0) {
      log.debug(
        `all ${req.tools.length} client tool(s) were filtered out — upstream will see no tools.`
      );
    }
    if (mapped.length > 0) chat.tools = dedupeToolsByName(mapped);

    // Phase C of issue #39: when first-party Codex Desktop connectors are
    // present (mcp + connector_id), inject a developer/system-prompt
    // advisory note so the upstream model doesn't generate phantom calls
    // to non-existent tools. The model is told to acknowledge the
    // limitation when relevant and fall back to `shell` + a CLI
    // equivalent instead — preventing Codex Desktop's "unsupported call"
    // error path entirely. Remote MCP (server_url, no connector_id) is
    // intentionally NOT covered here — that's Phase B's bridging job.
    const connectorLabels = collectFirstPartyConnectorLabels(req.tools);
    if (connectorLabels.length > 0) {
      const note = buildConnectorAdvisoryNote(connectorLabels);
      const insertAt = req.instructions ? 1 : 0;
      messages.splice(insertAt, 0, { role: "system", content: note });
    }
  }
  const tc = toolChoiceToChat(req.tool_choice);
  if (tc !== undefined) chat.tool_choice = tc;

  // parallel_tool_calls: --force-parallel-tool-calls overrides Codex's value.
  if (opts.forceParallelToolCalls) {
    chat.parallel_tool_calls = true;
  } else if (req.parallel_tool_calls !== undefined) {
    chat.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (req.temperature !== undefined && req.temperature !== null) {
    chat.temperature = req.temperature;
  }
  if (req.top_p !== undefined && req.top_p !== null) {
    chat.top_p = req.top_p;
  }
  if (req.max_output_tokens !== undefined && req.max_output_tokens !== null) {
    chat.max_completion_tokens = req.max_output_tokens;
  }

  // 把 Codex 的 reasoning.effort 翻成 chat completions 的 reasoning_effort。
  // 这是 OpenAI GPT-5 / DeepSeek V4 / SenseNova 6.7 都接受的事实标准字段。
  // mimo / deepseek builtin provider 的 normalizeBody 只在 chat.reasoning_effort
  // 仍为 undefined 时才注入默认值，所以本透传不会覆盖它们的默认行为；对 generic
  // provider（sensenova 等），让上游收到用户在 Codex 端配置的真实思考强度。
  // Responses 里的 "minimal" → chat 里没有对应值，降级为 "low"（语义最近）。
  //
  // 兜底：当 Codex 没传 reasoning.effort（多数客户端对非 GPT-5 模型默认不传）且
  // **admin UI 的"高强度思考兜底"开关显式打开**（opts.forceHighEffort=true）+ 没在关
  // 思考路径上 → 注 reasoning_effort="high"，让上游真高强度思考。默认关，避免简单请求
  // 也被强制思考。
  if (req.reasoning?.effort) {
    const eff = req.reasoning.effort;
    chat.reasoning_effort =
      eff === "minimal" ? "low" : (eff as ChatRequest["reasoning_effort"]);
  } else if (opts.forceHighEffort && !opts.disableThinking) {
    chat.reasoning_effort = "high";
  }

  // Mixed-mode history defense.
  //
  // Scenario: the user kept thinking OFF earlier in a conversation, then
  // toggled it ON via the admin UI and continued the same session. Now
  // `messages` contains historical assistant turns that have NO
  // reasoning_content (they were produced under thinking-off). MiMo / DeepSeek
  // in thinking mode scan the ENTIRE history and 400 with
  //   "The reasoning_content in the thinking mode must be passed back to the API."
  // even though the offending turns predate the current thinking-on request.
  //
  // Same symptom happens if the client (e.g. some Codex Desktop builds) just
  // doesn't echo reasoning items back across turns — every assistant message
  // will lack reasoning_content for the same reason.
  //
  // Fix: backfill a short placeholder `reasoning_content` onto each offending
  // historical assistant message. The placeholder satisfies upstream's
  // non-empty check while being honest that those turns ran without real
  // thinking. THIS request's thinking stays ON, so the user keeps the
  // benefit of the toggle they set in the admin UI.
  //
  // Alternative considered: silently force `thinking:{type:"disabled"}` for
  // this request. That works but defeats the user's intent. Placeholder
  // injection is the less surprising default — if the upstream ever rejects
  // the placeholder we'd see an obvious 400 in logs and can switch strategies.
  if (opts.disableThinking !== true) {
    let injected = 0;
    for (const m of chat.messages) {
      if (m.role === "assistant" && !m.reasoning_content) {
        m.reasoning_content = MIXED_MODE_REASONING_PLACEHOLDER;
        injected += 1;
      }
    }
    if (injected > 0) {
      log.info(
        `backfilled placeholder reasoning_content onto ${injected} historical assistant message(s) so thinking can stay ON for this request. ` +
          "These turns originally ran with thinking OFF (or the client didn't echo reasoning items). " +
          'Placeholder text: "' +
          MIXED_MODE_REASONING_PLACEHOLDER +
          '". If the upstream rejects this with a 400, please open an issue — we can fall back to silently disabling thinking.'
      );
    }
  }

  // 全局"关思考"信号：只设 thinking:{type:"disabled"}（OpenAI 标准做法，mimo / deepseek
  // 直接认）。reasoning_effort:"none" 是 SenseNova 6.7 的专属扩展，mimo / deepseek 上游
  // 会因为"未知枚举值"400（mimo 报 Input should be 'low','medium' or 'high'）。所以由各
  // generic provider 的 preprocessXxx 自己在剥掉 thinking 后**额外**注 reasoning_effort:"none"，
  // 不在这里一刀切。
  if (opts.disableThinking) {
    chat.thinking = { type: "disabled" };
  }

  return chat;
}

// Marker injected into historical assistant turns that lack reasoning_content
// when the current request is in thinking mode — keeps MiMo / DeepSeek from
// 400ing while signaling clearly to humans (and to the model) that the turn
// did not actually involve thinking. Short on purpose so it doesn't bias the
// model's continuation.
export const MIXED_MODE_REASONING_PLACEHOLDER = "(this turn ran without thinking mode)";
