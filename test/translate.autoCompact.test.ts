import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateTokens,
  planChatCompaction,
  renderMessagesAsText,
  maybeCompactChat,
  _clearSummaryCache,
  type ChatCaller,
} from "../src/translate/autoCompact.js";
import type { ChatMessage, ChatRequest } from "../src/translate/types.js";

function text(role: ChatMessage["role"], len: number, fill = "x"): ChatMessage {
  return { role, content: fill.repeat(len) };
}

afterEach(() => {
  _clearSummaryCache();
});

describe("estimateTokens", () => {
  it("counts ~chars/4 and a flat budget per image", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "a".repeat(400) }, // ~100 tokens + small overhead
    ];
    const t = estimateTokens(msgs);
    expect(t).toBeGreaterThanOrEqual(100);
    expect(t).toBeLessThan(120);

    const withImg: ChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:...huge..." } }] },
    ];
    // Image counts as the flat cost, not its base64 length.
    expect(estimateTokens(withImg)).toBeGreaterThanOrEqual(1024);
  });
});

describe("planChatCompaction", () => {
  it("returns null when under the trigger", () => {
    const msgs = [text("system", 40), text("user", 40), text("assistant", 40), text("user", 40)];
    expect(planChatCompaction(msgs, { atTokens: 100_000 })).toBeNull();
  });

  it("returns null for very short histories regardless of size", () => {
    const msgs = [text("user", 1_000_000)];
    expect(planChatCompaction(msgs, { atTokens: 10 })).toBeNull();
  });

  it("keeps leading system messages as head and starts the tail at a user message", () => {
    const msgs: ChatMessage[] = [
      text("system", 200), // head
      text("user", 4000),
      text("assistant", 4000),
      text("user", 4000),
      text("assistant", 4000),
      text("user", 4000),
      text("assistant", 4000),
      text("user", 400), // recent
      text("assistant", 400),
    ];
    const plan = planChatCompaction(msgs, { atTokens: 2000 });
    expect(plan).not.toBeNull();
    // Head is the leading system message(s).
    expect(plan!.head.every((m) => m.role === "system")).toBe(true);
    expect(plan!.head.length).toBe(1);
    // Tail must begin at a user message — never mid tool/assistant exchange.
    expect(plan!.tail[0].role).toBe("user");
    // Middle is non-empty and excluded from both head and tail.
    expect(plan!.middle.length).toBeGreaterThan(0);
    // Reassembling head+middle+tail covers exactly the original sequence.
    expect([...plan!.head, ...plan!.middle, ...plan!.tail]).toEqual(msgs);
  });

  it("snaps the tail boundary past tool/assistant messages to keep tool pairing intact", () => {
    const msgs: ChatMessage[] = [
      text("system", 100),
      text("user", 4000),
      text("assistant", 4000),
      text("user", 4000),
      text("assistant", 4000),
      // Recent turn: a small user message, then an assistant→tool exchange.
      text("user", 300),
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ];
    const plan = planChatCompaction(msgs, { atTokens: 2000 });
    expect(plan).not.toBeNull();
    // The tail cannot begin on the `assistant`/`tool` pair — it snaps to a user.
    expect(plan!.tail[0].role).toBe("user");
    // No orphaned tool message at the front of the tail.
    expect(plan!.tail.some((m, i) => m.role === "tool" && (i === 0 || plan!.tail[i - 1].role === "user"))).toBe(false);
  });
});

describe("renderMessagesAsText", () => {
  it("drops image base64 and flattens tool calls/results", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: "{\"x\":1}" } }] },
      { role: "tool", name: "run", content: "ok" },
    ];
    const out = renderMessagesAsText(msgs);
    expect(out).toContain("[image]");
    expect(out).not.toContain("AAAA"); // base64 never reaches the summarizer
    expect(out).toContain("[tool_calls: run({\"x\":1})]");
    expect(out).toContain("[tool_result run: ok]");
  });
});

describe("maybeCompactChat", () => {
  const bigHistory = (): ChatMessage[] => [
    text("system", 200),
    text("user", 4000),
    text("assistant", 4000),
    text("user", 4000),
    text("assistant", 4000),
    text("user", 400),
    text("assistant", 400),
  ];

  it("summarizes the middle, preserves head + tail, and shrinks the estimate", async () => {
    const chat: ChatRequest = { model: "m", messages: bigHistory() };
    const before = estimateTokens(chat.messages);
    const caller: ChatCaller = vi.fn(async () => "SUMMARY TEXT");
    const res = await maybeCompactChat(chat, { atTokens: 2000, callChat: caller });

    expect(res.compacted).toBe(true);
    expect(caller).toHaveBeenCalledTimes(1);
    // First message stays the system head; a summary user-message follows.
    expect(chat.messages[0].role).toBe("system");
    expect(chat.messages[1].role).toBe("user");
    expect(String(chat.messages[1].content)).toContain("SUMMARY TEXT");
    // Tail (most recent turns) is preserved verbatim at the end.
    expect(chat.messages[chat.messages.length - 1]).toEqual({ role: "assistant", content: "x".repeat(400) });
    expect(estimateTokens(chat.messages)).toBeLessThan(before);
  });

  it("caches the summary so a stable prefix isn't re-summarized", async () => {
    const caller: ChatCaller = vi.fn(async () => "SUMMARY");
    const chatA: ChatRequest = { model: "m", messages: bigHistory() };
    const chatB: ChatRequest = { model: "m", messages: bigHistory() };
    await maybeCompactChat(chatA, { atTokens: 2000, callChat: caller });
    await maybeCompactChat(chatB, { atTokens: 2000, callChat: caller });
    expect(caller).toHaveBeenCalledTimes(1); // second hit the cache
  });

  it("leaves history intact when the summarizer returns empty", async () => {
    const chat: ChatRequest = { model: "m", messages: bigHistory() };
    const original = [...chat.messages];
    const caller: ChatCaller = vi.fn(async () => "   ");
    const res = await maybeCompactChat(chat, { atTokens: 2000, callChat: caller });
    expect(res.compacted).toBe(false);
    expect(chat.messages).toEqual(original);
  });

  it("leaves history intact and does not throw when the summarizer errors", async () => {
    const chat: ChatRequest = { model: "m", messages: bigHistory() };
    const original = [...chat.messages];
    const caller: ChatCaller = vi.fn(async () => {
      throw new Error("upstream 429");
    });
    const res = await maybeCompactChat(chat, { atTokens: 2000, callChat: caller });
    expect(res.compacted).toBe(false);
    expect(chat.messages).toEqual(original);
  });

  it("is a no-op below the trigger", async () => {
    const chat: ChatRequest = { model: "m", messages: [text("user", 40), text("assistant", 40), text("user", 40), text("assistant", 40)] };
    const caller: ChatCaller = vi.fn(async () => "SUMMARY");
    const res = await maybeCompactChat(chat, { atTokens: 100_000, callChat: caller });
    expect(res.compacted).toBe(false);
    expect(caller).not.toHaveBeenCalled();
  });
});
