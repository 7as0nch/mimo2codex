// Automatic context compaction (issue #65 follow-up).
//
// Long Codex conversations resend their full history every turn. Once that
// history approaches the model's REAL context window, the upstream either 400s
// (context_length_exceeded) or takes so long to prefill that the stream
// disconnects. Codex has a manual /compact, but it doesn't always fire in time.
//
// This module summarizes the older middle of the conversation into one compact
// note when the estimated input crosses a token trigger, keeping the leading
// system messages and the most recent turns verbatim. It operates on the
// translated Chat-Completions `ChatMessage[]` (the simplest, pairing-safe
// representation) so the same logic covers MiMo / DeepSeek / generic-chat.
//
// IMPORTANT — why a token TRIGGER, not "% of contextWindow": MiMo and DeepSeek
// deliberately advertise a 1M `contextWindow` (so Codex doesn't pre-compact)
// while their real cap is ~128K. So the advertised window is useless for this
// decision; we trigger on an absolute estimated-token count instead (default
// 100k ≈ 80% of a real 128k window), tunable via env / admin.
import { createHash } from "node:crypto";
import type { ChatMessage, ChatRequest } from "./types.js";
import { log } from "../util/log.js";

// Rough heuristic — we only need a ballpark to decide WHEN to compact, not an
// exact tokenizer. ~4 chars/token for latin; CJK is denser but the trigger has
// generous headroom below the real cap so a mild underestimate is safe.
const CHARS_PER_TOKEN = 4;
// Images aren't text; count each as a flat budget rather than their base64
// length (which would massively overcount).
const IMAGE_TOKEN_COST = 1024;

export function estimateMessageTokens(msg: ChatMessage): number {
  let chars = (msg.role?.length ?? 0) + 4;
  let imageTokens = 0;
  const c = msg.content;
  if (typeof c === "string") {
    chars += c.length;
  } else if (Array.isArray(c)) {
    for (const part of c) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "image_url") imageTokens += IMAGE_TOKEN_COST;
    }
  }
  if (msg.reasoning_content) chars += msg.reasoning_content.length;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      chars += (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0) + 8;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + imageTokens;
}

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export interface CompactionPlan {
  head: ChatMessage[]; // leading system/developer messages, kept verbatim
  middle: ChatMessage[]; // older turns to summarize away
  tail: ChatMessage[]; // recent turns, kept verbatim; ALWAYS starts at a user msg
}

// Decide what to compact. Returns null when no compaction is needed or no safe
// split exists. The split is chosen so that:
//   • leading system/developer messages stay (head),
//   • the tail begins at a `user` message — never mid-exchange — so we can never
//     orphan an assistant tool_call from its `tool` result, and
//   • everything between becomes the summarizable middle.
export function planChatCompaction(
  messages: ChatMessage[],
  opts: { atTokens: number }
): CompactionPlan | null {
  if (messages.length < 4) return null;
  const total = estimateTokens(messages);
  if (total <= opts.atTokens) return null;

  // Head: leading consecutive system/developer messages.
  let headEnd = 0;
  while (
    headEnd < messages.length &&
    (messages[headEnd].role === "system" || messages[headEnd].role === "developer")
  ) {
    headEnd++;
  }

  // Keep the most recent turns within ~half the trigger budget, then snap the
  // cut forward to the nearest `user` message so the tail is self-consistent.
  const tailBudget = Math.max(1, Math.floor(opts.atTokens * 0.5));
  let acc = 0;
  let earliestInBudget = messages.length;
  for (let i = messages.length - 1; i >= headEnd; i--) {
    acc += estimateMessageTokens(messages[i]);
    if (acc > tailBudget) break;
    earliestInBudget = i;
  }
  // Snap forward to a clean user-message boundary.
  let cut = earliestInBudget;
  while (cut < messages.length && messages[cut].role !== "user") cut++;
  // No user boundary in the recent window (e.g. one gigantic final exchange) →
  // nothing safe to summarize without risking tool-pairing; skip.
  if (cut >= messages.length) return null;

  const head = messages.slice(0, headEnd);
  const middle = messages.slice(headEnd, cut);
  const tail = messages.slice(cut);
  if (middle.length === 0) return null;
  // Not worth a round-trip for a tiny middle.
  if (estimateTokens(middle) < 1000) return null;

  return { head, middle, tail };
}

// Render the middle to plain text for the summarizer. Images are dropped (we
// never feed base64 to the summary call), tool calls/results are flattened to a
// readable one-liner. Capped so the summary call itself can't blow the window —
// when over the cap we keep the head and the (more relevant) tail of the text.
export function renderMessagesAsText(messages: ChatMessage[], maxChars = 200_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    let text = "";
    const c = m.content;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c.map((p) => (p.type === "text" ? p.text : "[image]")).join("");
    }
    if (m.tool_calls?.length) {
      const calls = m.tool_calls
        .map((tc) => `${tc.function?.name ?? "?"}(${tc.function?.arguments ?? ""})`)
        .join("; ");
      text = text ? `${text}\n[tool_calls: ${calls}]` : `[tool_calls: ${calls}]`;
    }
    if (m.role === "tool") {
      text = `[tool_result${m.name ? ` ${m.name}` : ""}: ${text}]`;
    }
    if (!text) continue;
    lines.push(`${m.role}: ${text}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) {
    const headChars = 20_000;
    out =
      out.slice(0, headChars) +
      "\n\n...[earlier middle elided to fit summarizer]...\n\n" +
      out.slice(out.length - (maxChars - headChars));
  }
  return out;
}

export const SUMMARY_SYSTEM_PROMPT =
  "You are compressing an in-progress coding-assistant conversation so it fits " +
  "the model's context window. Write a concise but information-dense summary in " +
  "the same language as the conversation. PRESERVE: the user's goals and tasks, " +
  "key decisions, important code and file paths, commands run and their outcomes, " +
  "the current state, and any unresolved errors or TODOs. OMIT pleasantries and " +
  "redundant detail. Output only the summary, no preamble.";

// Caller-injected upstream chat function (so tests don't hit the network).
// Returns the assistant message content (the summary text).
export type ChatCaller = (req: ChatRequest) => Promise<string>;

export async function summarizeMiddle(
  middle: ChatMessage[],
  model: string,
  callChat: ChatCaller,
  opts?: { maxTokens?: number }
): Promise<string> {
  const text = renderMessagesAsText(middle);
  const req: ChatRequest = {
    model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    stream: false,
    max_completion_tokens: opts?.maxTokens ?? 1500,
    temperature: 0.2,
    // Summaries don't need a reasoning trace — keep them fast/cheap where the
    // upstream honors these (MiMo / DeepSeek). Ignored elsewhere.
    thinking: { type: "disabled" },
  };
  return await callChat(req);
}

// Small in-memory LRU so a stable history prefix isn't re-summarized every turn.
const summaryCache = new Map<string, string>();
const CACHE_MAX = 64;

export function summaryCacheKey(model: string, renderedMiddle: string): string {
  return createHash("sha1").update(`${model}\n${renderedMiddle}`).digest("hex");
}

// For tests.
export function _clearSummaryCache(): void {
  summaryCache.clear();
}

export interface CompactResult {
  compacted: boolean;
  beforeTokens?: number;
  afterTokens?: number;
  summarizedMessages?: number;
  cached?: boolean;
}

// Mutates `chat.messages` in place when compaction happens. Safe no-op when not
// needed, when no contextWindow trigger applies, or when the summarizer returns
// empty (we then leave the original history untouched and let the normal
// overflow handling deal with it).
export async function maybeCompactChat(
  chat: ChatRequest,
  ctx: { atTokens: number; callChat: ChatCaller; summaryMaxTokens?: number }
): Promise<CompactResult> {
  const plan = planChatCompaction(chat.messages, { atTokens: ctx.atTokens });
  if (!plan) return { compacted: false };

  const beforeTokens = estimateTokens(chat.messages);
  const rendered = renderMessagesAsText(plan.middle);
  const key = summaryCacheKey(chat.model, rendered);
  let summary = summaryCache.get(key);
  let cached = true;
  if (summary === undefined) {
    cached = false;
    try {
      summary = await summarizeMiddle(plan.middle, chat.model, ctx.callChat, {
        maxTokens: ctx.summaryMaxTokens,
      });
    } catch (err) {
      log.warn(`auto-compact summary failed; leaving history intact: ${(err as Error).message}`);
      return { compacted: false };
    }
    if (summary && summary.trim()) {
      summaryCache.set(key, summary);
      if (summaryCache.size > CACHE_MAX) {
        const oldest = summaryCache.keys().next().value;
        if (oldest !== undefined) summaryCache.delete(oldest);
      }
    }
  }
  if (!summary || !summary.trim()) return { compacted: false };

  const summaryMsg: ChatMessage = {
    role: "user",
    content:
      `[Auto-compacted summary of ${plan.middle.length} earlier message(s), ` +
      `inserted by mimo2codex to fit the context window. Treat as prior context.]\n\n` +
      summary.trim(),
  };
  chat.messages = [...plan.head, summaryMsg, ...plan.tail];
  const afterTokens = estimateTokens(chat.messages);
  log.info("auto-compacted conversation history", {
    model: chat.model,
    before_tokens: beforeTokens,
    after_tokens: afterTokens,
    summarized_messages: plan.middle.length,
    cached,
  });
  return {
    compacted: true,
    beforeTokens,
    afterTokens,
    summarizedMessages: plan.middle.length,
    cached,
  };
}
