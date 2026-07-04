import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reqToChat, MIXED_MODE_REASONING_PLACEHOLDER } from "../src/translate/reqToChat.js";
import type { ResponsesRequest } from "../src/translate/types.js";
import { log } from "../src/util/log.js";

describe("reqToChat", () => {
  it("instructions-only request becomes a single system message", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      instructions: "You are MiMo.",
      input: [],
    };
    const chat = reqToChat(req);
    // 默认 opts.forceHighEffort=false → 不注 reasoning_effort。
    expect(chat).toEqual({
      model: "mimo-v2.5-pro",
      messages: [{ role: "system", content: "You are MiMo." }],
      stream: false,
    });
  });

  it("simple user text", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      instructions: "be helpful",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    };
    const chat = reqToChat(req);
    expect(chat.messages).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("string input is treated as user content", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "hello",
    };
    const chat = reqToChat(req);
    expect(chat.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("developer role becomes system", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "x" }] },
      ],
    };
    const chat = reqToChat(req);
    expect(chat.messages[0]).toEqual({ role: "system", content: "x" });
  });

  it("tool definitions wrap into function objects", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          name: "shell",
          description: "run shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
          strict: true,
        },
      ],
      tool_choice: "auto",
    };
    const chat = reqToChat(req);
    expect(chat.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "run shell",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
          strict: true,
        },
      },
    ]);
    expect(chat.tool_choice).toBe("auto");
  });

  it("tool_choice with named function", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tool_choice: { type: "function", function: { name: "shell" } },
    };
    const chat = reqToChat(req);
    expect(chat.tool_choice).toEqual({ type: "function", function: { name: "shell" } });
  });

  // issue #11 regression: 默认（未传 strict）/ 显式传 null 时，都不应该在
  // outgoing function 上写 `strict: null` — MiMo 的 Pydantic schema 会以
  // "Input should be a valid boolean" 400。
  it("function tool without strict → outgoing tool omits strict field (issue #11)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object" },
        },
      ],
    };
    const chat = reqToChat(req);
    const fn = (chat.tools![0] as { function: Record<string, unknown> }).function;
    expect("strict" in fn).toBe(false);
  });

  it("function tool with explicit strict: null → outgoing tool omits strict field (issue #11)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object" },
          strict: null,
        } as unknown as ResponsesRequest["tools"][number],
      ],
    };
    const chat = reqToChat(req);
    const fn = (chat.tools![0] as { function: Record<string, unknown> }).function;
    expect("strict" in fn).toBe(false);
  });

  it("function tool with explicit strict: false → outgoing tool preserves strict: false (issue #11)", () => {
    // 显式 boolean 必须保留（用户明确意图）
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: { type: "object" },
          strict: false,
        },
      ],
    };
    const chat = reqToChat(req);
    const fn = (chat.tools![0] as { function: { strict?: boolean } }).function;
    expect(fn.strict).toBe(false);
  });

  it("local_shell builtin → outgoing shell function omits strict field (issue #11)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [{ type: "local_shell" }],
    };
    const chat = reqToChat(req);
    const fn = (chat.tools![0] as { function: Record<string, unknown> }).function;
    expect("strict" in fn).toBe(false);
    expect(fn.name).toBe("shell");
  });

  it("custom tool → outgoing function omits strict field (issue #11)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [{ type: "message", role: "user", content: "go" }],
      tools: [
        {
          type: "custom",
          name: "grammar_tool",
          description: "custom thing",
          format: { type: "grammar" },
        } as unknown as ResponsesRequest["tools"][number],
      ],
    };
    const chat = reqToChat(req);
    const fn = (chat.tools![0] as { function: Record<string, unknown> }).function;
    expect("strict" in fn).toBe(false);
  });

  it("function_call from history with output (round trip after tool exec)", () => {
    // Fixture predates the mixed-mode history defense: the historical
    // assistant tool-call turn has no reasoning_content. With the defense,
    // a placeholder is backfilled so MiMo / DeepSeek thinking mode doesn't 400.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        {
          type: "function_call",
          call_id: "call_abc",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        { type: "function_call_output", call_id: "call_abc", output: "a.txt\nb.txt" },
        { type: "message", role: "user", content: "thanks, count them" },
      ],
    };
    const chat = reqToChat(req);
    // issue #29: tool_calls 存在时省略 content 字段（不再发 content: null）。
    expect(chat.messages).toEqual([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "shell", arguments: '{"cmd":"ls"}' },
          },
        ],
        reasoning_content: MIXED_MODE_REASONING_PLACEHOLDER,
      },
      { role: "tool", tool_call_id: "call_abc", content: "a.txt\nb.txt" },
      { role: "user", content: "thanks, count them" },
    ]);
  });

  it("assistant text + reasoning + function_calls in same turn collapse into ONE assistant message", () => {
    // Regression: previously the assistant message item triggered an immediate
    // flush, leaving the subsequent function_call items in a second assistant
    // message without reasoning_content. DeepSeek V4 thinking mode rejects
    // assistant messages without reasoning_content with 400
    // "The reasoning_content in the thinking mode must be passed back to the API".
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "几点了，项目大不大" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I'll check the time and list files." }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "先快速扫一眼项目结构" }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "shell",
          arguments: '{"command":["date"]}',
        },
        { type: "function_call_output", call_id: "c1", output: "2026-05-10 14:17" },
      ],
    };
    const chat = reqToChat(req);
    expect(chat.messages).toEqual([
      { role: "user", content: "几点了，项目大不大" },
      {
        role: "assistant",
        content: "先快速扫一眼项目结构",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "shell", arguments: '{"command":["date"]}' },
          },
        ],
        reasoning_content: "I'll check the time and list files.",
      },
      { role: "tool", tool_call_id: "c1", content: "2026-05-10 14:17" },
    ]);
  });

  it("reasoning + function_call collapse into single assistant turn with reasoning_content", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        { type: "message", role: "user", content: "search for cats" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should call the search tool." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"cats"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "5 results" },
      ],
    };
    const chat = reqToChat(req);
    // issue #29: tool_calls 存在时省略 content 字段。
    expect(chat.messages).toEqual([
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"cats"}' },
          },
        ],
        reasoning_content: "I should call the search tool.",
      },
      { role: "tool", tool_call_id: "call_1", content: "5 results" },
    ]);
  });

  it("reasoning AFTER function_call folds into the SAME assistant message (DeepSeek 400 bug)", () => {
    // Regression for DeepSeek 400:
    //   "An assistant message with 'tool_calls' must be followed by tool messages
    //    responding to each 'tool_call_id'. (insufficient tool messages following
    //    tool_calls message)"
    //
    // Codex sometimes emits reasoning AFTER the function_call (or between
    // function_call and function_call_output). Previously this flushed the
    // pending tool_calls into one assistant message and the reasoning into a
    // SECOND assistant message — interposing it between tool_calls and the
    // tool result, which violates the Chat Completions contiguity invariant.
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "run ls" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thought about it after deciding to call" }],
        },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      ],
    };
    const chat = reqToChat(req);
    // The crucial structural invariant: assistant(tool_calls) MUST be
    // immediately followed by tool messages — no other assistant message
    // may be wedged in between.
    // issue #29: tool_calls 存在时省略 content 字段。
    expect(chat.messages).toEqual([
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: '{"cmd":"ls"}' },
          },
        ],
        reasoning_content: "thought about it after deciding to call",
      },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ]);
  });

  it("reasoning BETWEEN multiple function_calls in the same turn folds correctly", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A and B" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "now also calling B" }],
        },
        {
          type: "function_call",
          call_id: "call_B",
          name: "shell",
          arguments: '{"cmd":"B"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
        { type: "function_call_output", call_id: "call_B", output: "rb" },
      ],
    };
    const chat = reqToChat(req);
    // Both tool_calls in ONE assistant message, both tool messages follow
    // immediately, no interloper.
    expect(chat.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(chat.messages[1].tool_calls?.map((tc) => tc.id)).toEqual([
      "call_A",
      "call_B",
    ]);
    expect(chat.messages[2].tool_call_id).toBe("call_A");
    expect(chat.messages[3].tool_call_id).toBe("call_B");
  });

  it("missing function_call_output gets a synthetic tool message placeholder (defensive)", () => {
    // Defensive backstop: if Codex's input is missing a function_call_output
    // for one of the tool_calls (cancelled turn, dropped output, etc.),
    // synthesize a placeholder tool message rather than emit an invalid body.
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A and B" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        {
          type: "function_call",
          call_id: "call_B",
          name: "shell",
          arguments: '{"cmd":"B"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
        // call_B output is MISSING
        { type: "message", role: "user", content: "follow-up" },
      ],
    };
    const chat = reqToChat(req);
    const idxAsst = chat.messages.findIndex(
      (m) => m.role === "assistant" && m.tool_calls?.length
    );
    expect(idxAsst).toBeGreaterThanOrEqual(0);
    const expectedIds = chat.messages[idxAsst].tool_calls!.map((tc) => tc.id);
    // Collect tool messages immediately following the assistant.
    const followingTools: string[] = [];
    for (let i = idxAsst + 1; i < chat.messages.length; i++) {
      const m = chat.messages[i];
      if (m.role !== "tool") break;
      followingTools.push(m.tool_call_id!);
    }
    expect(followingTools).toEqual(expectedIds);
  });

  it("user message with text + image parts (omni model — images preserved)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2-omni",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what's this?" },
            { type: "input_image", image_url: "https://x/y.png", detail: "auto" },
          ],
        },
      ],
    };
    const chat = reqToChat(req);
    expect(chat.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what's this?" },
        { type: "image_url", image_url: { url: "https://x/y.png", detail: "auto" } },
      ],
    });
  });

  it("drops image parts on non-omni model and adds an inline placeholder note", () => {
    // mimo-v2.5-pro and friends return 404 "No endpoints found that support image
    // input" if image_url parts are forwarded. We strip them with a short note so
    // the model still has context that an image was attached.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what's this?" },
            { type: "input_image", image_url: "https://x/y.png" },
            { type: "input_image", image_url: "https://x/z.png" },
          ],
        },
      ],
    };
    const chat = reqToChat(req);
    // Should be a single user message with text only (collapsed to string when
    // all parts are text after dropping images)
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].role).toBe("user");
    const content = chat.messages[0].content;
    expect(typeof content).toBe("string");
    expect(content).toContain("what's this?");
    expect(content).toContain("2 image attachments omitted");
    expect(content).toContain("mimo-v2.5");
    // Definitely no image_url part
    expect(JSON.stringify(chat.messages[0])).not.toContain("image_url");
  });

  it("preserves images on plain `mimo-v2.5` (image-understanding model per docs)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "https://x/y.png" },
          ],
        },
      ],
    };
    const chat = reqToChat(req);
    expect(JSON.stringify(chat.messages[0])).toContain("image_url");
  });

  it("DROPS images on mimo-v2.5-pro (per official docs: only mimo-v2.5 and -omni support vision)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what's this?" },
            { type: "input_image", image_url: "https://x/y.png" },
          ],
        },
      ],
    };
    const chat = reqToChat(req);
    expect(JSON.stringify(chat.messages[0])).not.toContain("image_url");
    expect(chat.messages[0].content).toContain("what's this?");
    expect(chat.messages[0].content).toContain("image attachment");
  });

  it("ensures a text part exists when image_url is present (avoid MiMo 400 'text is not set')", () => {
    // Image-only user message — Codex CLI / desktop allow paste+enter without typing.
    // MiMo's image API requires at least one text part in the content array.
    const req: ResponsesRequest = {
      model: "mimo-v2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://x/y.png" }],
        },
      ],
    };
    const chat = reqToChat(req);
    const content = chat.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    // Must have BOTH image_url and text parts
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  it("does NOT add a fallback text part when image is absent (text-only stays clean)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };
    const chat = reqToChat(req);
    // text-only collapses to string, no extra spaces or padding parts
    expect(chat.messages[0].content).toBe("hello");
  });

  it("filters input_text parts whose `text` is empty/missing — MiMo rejects them", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "" },
            { type: "input_text" } as unknown as { type: "input_text"; text: string },
            { type: "input_text", text: "real content" },
            { type: "input_image", image_url: "https://x/y.png" },
          ],
        },
      ],
    };
    const chat = reqToChat(req);
    const content = chat.messages[0].content as Array<{ type: string; text?: string }>;
    const textParts = content.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text).toBe("real content");
  });

  it("on pro model with image-only message, output is non-empty text-only string (the original 400 case)", () => {
    // The exact scenario that produced "MiMo returned 400: text is not set":
    // model = mimo-v2.5-pro (no vision) + content has only an image.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://x/y.png" }],
        },
      ],
    };
    const chat = reqToChat(req);
    const content = chat.messages[0].content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeGreaterThan(0);
    expect(content).toContain("image attachment");
    expect(JSON.stringify(chat.messages[0])).not.toContain("image_url");
  });

  it("max_output_tokens maps to max_completion_tokens (not max_tokens)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      max_output_tokens: 1024,
    };
    const chat = reqToChat(req);
    expect(chat.max_completion_tokens).toBe(1024);
    expect((chat as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  it("preserves stream flag", () => {
    const req: ResponsesRequest = { model: "mimo-v2.5-pro", input: "x", stream: true };
    expect(reqToChat(req).stream).toBe(true);
  });

  it("drops web_search by default (Web Search Plugin not assumed activated)", () => {
    // web_search_preview is dropped unless --web-search is explicitly passed
    // because MiMo's plugin is separately billed and 400s if not activated.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "code_interpreter" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "function", name: "shell", parameters: { type: "object" } },
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools![0].type).toBe("function");
  });

  it("forwards web_search to MiMo when --web-search (enableWebSearch: true) is set", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "code_interpreter" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "function", name: "shell", parameters: { type: "object" } },
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req, { enableWebSearch: true });
    expect(chat.tools).toHaveLength(2);
    const types = chat.tools!.map((t) => t.type).sort();
    expect(types).toEqual(["function", "web_search"]);
  });

  it("translates local_shell builtin into a function tool named 'shell'", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "list files",
      tools: [{ type: "local_shell" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toHaveLength(1);
    const fn = chat.tools![0].function;
    expect(fn.name).toBe("shell");
    expect(fn.parameters).toBeDefined();
    expect((fn.parameters as { properties: Record<string, unknown> }).properties.command).toBeDefined();
  });

  it("drops function tool that has no name instead of forwarding name=undefined", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [{ type: "function" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toBeUndefined(); // empty after filter, field omitted entirely
  });

  it("when ALL tools get filtered (truly unsupported only), the tools field is omitted entirely", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "code_interpreter" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "image_generation" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toBeUndefined();
  });

  it("translates `custom` tool type into a function tool with permissive schema", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        {
          type: "custom",
          name: "my_grammar_tool",
          description: "Output a SQL query.",
          format: { type: "grammar", syntax: "lark", definition: "..." },
        } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toHaveLength(1);
    const fn = chat.tools![0].function;
    expect(fn.name).toBe("my_grammar_tool");
    expect(fn.description).toContain("SQL");
    expect(fn.description).toContain("grammar");
    expect((fn.parameters as { type: string }).type).toBe("object");
  });

  it("recurses into `namespace` wrapper and flattens nested function + builtin tools", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        {
          type: "namespace",
          name: "playwright",
          tools: [
            { type: "function", name: "browser_open", parameters: { type: "object" } },
            { type: "function", name: "browser_click", parameters: { type: "object" } },
            { type: "code_interpreter" }, // nested server-only — should drop
          ],
        } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "function", name: "shell", parameters: { type: "object" } },
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toHaveLength(3);
    const names = chat.tools!
      .filter((t): t is { type: "function"; function: { name: string } } => t.type === "function")
      .map((t) => t.function.name)
      .sort();
    expect(names).toEqual(["browser_click", "browser_open", "shell"]);
  });

  it("server-side-only tools (code_interpreter, computer_use, etc.) are silently dropped", () => {
    // These have no MiMo equivalent; they're silently dropped.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "code_interpreter" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "computer_use_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "image_generation" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req);
    expect(chat.tools).toBeUndefined();
  });

  it("Codex web_search_preview is translated to MiMo's native web_search builtin (with --web-search)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "今天上海天气?",
      tools: [
        {
          type: "web_search_preview",
          user_location: { type: "approximate", country: "China", city: "Shanghai" },
          search_context_size: "medium",
        } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req, { enableWebSearch: true });
    expect(chat.tools).toHaveLength(1);
    const tool = chat.tools![0] as { type: string; user_location?: { city?: string } };
    expect(tool.type).toBe("web_search");
    expect(tool.user_location?.city).toBe("Shanghai");
    expect((tool as Record<string, unknown>).search_context_size).toBeUndefined();
    expect((tool as Record<string, unknown>).function).toBeUndefined();
  });

  // Issue #20: Codex CLI / Desktop / DeX can send the same tool name twice
  // (e.g. a top-level `_fetch` function + a `namespace`-wrapped `_fetch` that
  // flattens to a second copy). MiMo rejects with
  //   400 Param Incorrect: tools contains duplicate names: _fetch
  // reqToChat must dedupe defensively.
  describe("tool dedup (issue #20)", () => {
    it("two function tools with the same name → keep first, drop second", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "hi",
        tools: [
          { type: "function", name: "_fetch", description: "first" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "_fetch", description: "second (duplicate)" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(1);
      const fn = (chat.tools![0] as { type: string; function: { name: string; description?: string } });
      expect(fn.type).toBe("function");
      expect(fn.function.name).toBe("_fetch");
      expect(fn.function.description).toBe("first");
    });

    it("top-level function + namespace-wrapped same name → deduped (real-world #20 shape)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "hi",
        tools: [
          { type: "function", name: "_fetch", description: "top-level" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          {
            type: "namespace",
            name: "builtin",
            tools: [
              { type: "function", name: "_fetch", description: "nested" },
            ],
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      // 2 tools came in (top-level + namespace flattens to 1); dedup leaves 1.
      expect(chat.tools).toHaveLength(1);
      const fn = (chat.tools![0] as { function: { name: string; description?: string } });
      expect(fn.function.name).toBe("_fetch");
      // First-wins keeps the top-level definition.
      expect(fn.function.description).toBe("top-level");
    });

    it("two web_search builtin tools → deduped to one", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          { type: "web_search" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req, { enableWebSearch: true });
      // Both translate to MiMo's `web_search` builtin → dedupe collapses them.
      expect(chat.tools).toHaveLength(1);
      expect((chat.tools![0] as { type: string }).type).toBe("web_search");
    });

    it("different tool names are NOT deduped (regression guard)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "hi",
        tools: [
          { type: "function", name: "_fetch" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "_search" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "_apply_patch" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(3);
    });

    it("function `web_search` and builtin `web_search` live in different namespaces → both kept", () => {
      // Pathological mix: a function tool happens to be named "web_search"
      // and the client also includes the builtin web_search. They don't
      // collide in our dedup model (one is fn:web_search, the other is
      // builtin:web_search) — matching how upstream validates.
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          { type: "function", name: "web_search", description: "user-defined fn" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "web_search" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req, { enableWebSearch: true });
      expect(chat.tools).toHaveLength(2);
      const types = chat.tools!.map((t) => t.type).sort();
      expect(types).toEqual(["function", "web_search"]);
    });
  });

  it("plain Codex web_search (no user_location) is translated and preserves MiMo extras (with --web-search)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        {
          type: "web_search",
          max_keyword: 5,
          force_search: true,
          limit: 3,
        } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = reqToChat(req, { enableWebSearch: true });
    expect(chat.tools).toHaveLength(1);
    const tool = chat.tools![0] as Record<string, unknown>;
    expect(tool.type).toBe("web_search");
    expect(tool.max_keyword).toBe(5);
    expect(tool.force_search).toBe(true);
    expect(tool.limit).toBe(3);
    expect(tool.user_location).toBeUndefined();
  });

  it("--disable-thinking adds `thinking: {type: 'disabled'}` to the chat body", () => {
    const req: ResponsesRequest = { model: "mimo-v2.5-pro", input: "hi" };
    const chat = reqToChat(req, { disableThinking: true });
    expect((chat as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
  });

  it("--disable-thinking is OFF by default (no `thinking` field added)", () => {
    const req: ResponsesRequest = { model: "mimo-v2.5-pro", input: "hi" };
    const chat = reqToChat(req);
    expect((chat as Record<string, unknown>).thinking).toBeUndefined();
  });

  // Mixed-mode history defense: when thinking was OFF earlier in a session
  // then the user toggled it ON, the historical assistant turns lack
  // reasoning_content. MiMo / DeepSeek thinking mode scan the entire history
  // and 400. Defense: backfill a short placeholder reasoning_content onto the
  // offenders so thinking STAYS ON for this request (preserving the user's
  // intent), while still satisfying the upstream's non-empty check.
  describe("mixed-mode history defense", () => {
    it("history with assistant lacking reasoning_content + thinking-on → backfills placeholder, KEEPS thinking on", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "first turn" }] },
          // Assistant turn produced under thinking-off → no reasoning_content
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "follow-up after toggling thinking on" }] },
        ],
      };
      // disableThinking left default (false) — user toggled thinking ON in admin UI
      const chat = reqToChat(req);

      // Thinking stays ON for this request (no thinking:{disabled})
      expect((chat as Record<string, unknown>).thinking).toBeUndefined();

      // The offending historical assistant gets the placeholder injected
      const assistantMsg = chat.messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.reasoning_content).toBe(MIXED_MODE_REASONING_PLACEHOLDER);
    });

    it("fresh conversation (no assistant turn yet) → does NOT trigger backfill", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "first ever message" }] },
        ],
      };
      const chat = reqToChat(req);
      expect((chat as Record<string, unknown>).thinking).toBeUndefined();
      // No assistant message → nothing to inspect or modify.
      expect(chat.messages.find((m) => m.role === "assistant")).toBeUndefined();
    });

    it("history with assistant carrying reasoning_content (proper thinking-on round-trip) → preserves the real reasoning, NO placeholder", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
          // Client echoed the reasoning item back → reqToChat folds it onto the assistant message
          {
            type: "reasoning",
            id: "r1",
            summary: [{ type: "summary_text", text: "thought" }],
            encrypted_content: "full thinking trace",
            status: "completed",
          } as unknown as Parameters<typeof reqToChat>[0]["input"] extends Array<infer U> ? U : never,
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
        ],
      };
      const chat = reqToChat(req);
      const assistantMsg = chat.messages.find((m) => m.role === "assistant");
      // Real reasoning preserved, NOT overwritten by placeholder.
      expect(assistantMsg?.reasoning_content).toBe("full thinking trace");
      expect(assistantMsg?.reasoning_content).not.toBe(MIXED_MODE_REASONING_PLACEHOLDER);
      expect((chat as Record<string, unknown>).thinking).toBeUndefined();
    });

    it("mixed-mode + forceHighEffort → backfills placeholder, KEEPS reasoning_effort='high' (thinking is on, so high effort is consistent)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ans" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "follow-up" }] },
        ],
      };
      const chat = reqToChat(req, { forceHighEffort: true });
      expect((chat as Record<string, unknown>).thinking).toBeUndefined();
      expect(chat.reasoning_effort).toBe("high");
      const assistantMsg = chat.messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.reasoning_content).toBe(MIXED_MODE_REASONING_PLACEHOLDER);
    });

    it("explicit disableThinking=true → no placeholder backfill (user opted out of thinking entirely)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
        ],
      };
      const chat = reqToChat(req, { disableThinking: true });
      expect((chat as Record<string, unknown>).thinking).toEqual({ type: "disabled" });
      // No placeholder needed when thinking is off — upstream won't enforce the check.
      const assistantMsg = chat.messages.find((m) => m.role === "assistant");
      expect(assistantMsg?.reasoning_content).toBeUndefined();
    });

    it("multiple offending historical assistants → all get the placeholder", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "a2" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "q3 with thinking on" }] },
        ],
      };
      const chat = reqToChat(req);
      const assistants = chat.messages.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(2);
      for (const a of assistants) {
        expect(a.reasoning_content).toBe(MIXED_MODE_REASONING_PLACEHOLDER);
      }
    });
  });

  it("--force-parallel-tool-calls overrides Codex's parallel_tool_calls=false", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "hi",
      parallel_tool_calls: false,
    };
    const chat = reqToChat(req, { forceParallelToolCalls: true });
    expect(chat.parallel_tool_calls).toBe(true);
  });

  it("without --force-parallel-tool-calls, Codex's parallel_tool_calls value is respected", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "hi",
      parallel_tool_calls: false,
    };
    const chat = reqToChat(req);
    expect(chat.parallel_tool_calls).toBe(false);
  });

  // Regression: when an image-gen tool returns its result as a structured
  // array containing `input_image` parts, the proxy must NOT forward the
  // array verbatim to upstream — Chat Completions tool messages only accept
  // a string content, and DeepSeek explicitly 400s with
  // "unknown variant `input_image`, expected `text`". The array must be
  // flattened: text parts joined, image parts dropped with a placeholder.
  it("function_call_output with array containing input_image is flattened to a string with placeholder", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "generate a pet" }] },
        {
          type: "function_call",
          call_id: "call_img_1",
          name: "generate_image",
          arguments: '{"description":"chibi shiba"}',
        },
        {
          type: "function_call_output",
          call_id: "call_img_1",
          output: [
            { type: "output_text", text: "pet.png generated successfully." },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo..." },
          ] as any,
        },
      ],
    };
    const chat = reqToChat(req);
    const tool = chat.messages.find((m) => m.role === "tool") as
      | { role: "tool"; tool_call_id: string; content: string }
      | undefined;
    expect(tool).toBeDefined();
    expect(typeof tool!.content).toBe("string");
    expect(tool!.content).toContain("pet.png generated successfully.");
    expect(tool!.content).toContain("[1 image attachment omitted from tool output");
    expect(tool!.content).not.toContain("input_image");
    expect(tool!.content).not.toContain("data:image");
  });

  it("function_call_output with plain string output is unchanged (regression guard)", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        {
          type: "function_call",
          call_id: "c1",
          name: "shell",
          arguments: '{"cmd":"date"}',
        },
        { type: "function_call_output", call_id: "c1", output: "2026-05-12" },
      ],
    };
    const chat = reqToChat(req);
    const tool = chat.messages.find((m) => m.role === "tool") as
      | { role: "tool"; tool_call_id: string; content: string }
      | undefined;
    expect(tool?.content).toBe("2026-05-12");
  });

  // Regression: when a user pastes an image into Codex with a non-vision chat
  // model (DS / mimo-v2.5-pro / Qwen text-only), the proxy must NOT just leave
  // a vague "<path>" placeholder — that produces the unhelpful agent reply
  // "tell me the file path of the image". Instead, the data URL must be
  // materialized to disk and the absolute path included in the placeholder so
  // the agent can run `ocr.py <path>` without further user input.
  it("non-vision model: data: image URL is materialized to disk and path embedded in placeholder", () => {
    const dropDir = mkdtempSync(join(tmpdir(), "mimo2codex-test-"));
    try {
      // 1x1 transparent PNG (smallest valid PNG bytes)
      const png1x1 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      const req: ResponsesRequest = {
        model: "deepseek-v4-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "what does this say" },
              { type: "input_image", image_url: `data:image/png;base64,${png1x1}` },
            ],
          },
        ],
      };
      const chat = reqToChat(req, { imageDropDir: dropDir });
      const msg = chat.messages[0];
      expect(msg.role).toBe("user");
      const content = typeof msg.content === "string" ? msg.content : "";
      expect(content).toContain("1 image attachment omitted");
      expect(content).toContain("mimoskill/scripts/ocr.py");
      // Should NOT have the old "<path>" placeholder that prompts the agent
      // to ask the user.
      expect(content).not.toMatch(/`.*ocr\.py <path>`/);

      // Extract the materialized path — should exist on disk and match
      // the original bytes.
      const pathMatch = content.match(/^\s+1\.\s+(.+)$/m);
      expect(pathMatch).toBeTruthy();
      const materializedPath = pathMatch![1];
      expect(materializedPath).toContain("cache");
      expect(materializedPath).toContain("images");
      expect(materializedPath.endsWith(".png")).toBe(true);
      expect(existsSync(materializedPath)).toBe(true);
      expect(readFileSync(materializedPath)).toEqual(Buffer.from(png1x1, "base64"));
    } finally {
      rmSync(dropDir, { recursive: true, force: true });
    }
  });

  it("non-vision model: http(s) image URLs are surfaced as-is in placeholder (no download)", () => {
    const dropDir = mkdtempSync(join(tmpdir(), "mimo2codex-test-"));
    try {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "input_image", image_url: "https://example.com/photo.jpg" },
            ],
          },
        ],
      };
      const chat = reqToChat(req, { imageDropDir: dropDir });
      const content =
        typeof chat.messages[0].content === "string" ? chat.messages[0].content : "";
      expect(content).toContain("https://example.com/photo.jpg");
    } finally {
      rmSync(dropDir, { recursive: true, force: true });
    }
  });

  it("non-vision model with no imageDropDir: falls back to tmpdir, still materializes", () => {
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/png;base64,${png1x1}` },
          ],
        },
      ],
    };
    const chat = reqToChat(req); // no opts
    const content =
      typeof chat.messages[0].content === "string" ? chat.messages[0].content : "";
    expect(content).toContain("1 image attachment omitted");
    // Should still produce a path in the fallback location.
    const pathMatch = content.match(/^\s+1\.\s+(.+)$/m);
    expect(pathMatch).toBeTruthy();
    expect(existsSync(pathMatch![1])).toBe(true);
  });

  // Bug: when admin runtime override / model alias maps the client's model
  // id to a DIFFERENT upstream model, the vision-capability check must follow
  // the upstream model, not the client literal. Otherwise sending images to a
  // proxy that rewrites `mimo-v2.5-pro` → `mimo-v2.5` (which DOES support
  // vision) still strips the images at the proxy layer, because reqToChat
  // only looked at req.model.
  describe("vision capability follows upstreamModel, not client model (v0.5.4 hotfix)", () => {
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    function visionReq(clientModel: string): ResponsesRequest {
      return {
        model: clientModel,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "describe this" },
              { type: "input_image", image_url: `data:image/png;base64,${png1x1}` },
            ],
          },
        ],
      };
    }

    it("client `mimo-v2.5-pro` + upstreamModel `mimo-v2.5` → image PASSES through (upstream supports vision)", () => {
      const chat = reqToChat(visionReq("mimo-v2.5-pro"), { upstreamModel: "mimo-v2.5" });
      const msg = chat.messages[0];
      expect(msg.role).toBe("user");
      // Image survives — content is an array with an image_url part.
      expect(Array.isArray(msg.content)).toBe(true);
      const parts = msg.content as Array<{ type: string }>;
      const hasImage = parts.some((p) => p.type === "image_url");
      expect(hasImage).toBe(true);
    });

    it("client `mimo-v2.5` + upstreamModel `mimo-v2.5-pro` → image STRIPPED (upstream does not support vision)", () => {
      const dropDir = mkdtempSync(join(tmpdir(), "mimo2codex-test-"));
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      try {
        const chat = reqToChat(visionReq("mimo-v2.5"), {
          upstreamModel: "mimo-v2.5-pro",
          imageDropDir: dropDir,
        });
        const content =
          typeof chat.messages[0].content === "string" ? chat.messages[0].content : "";
        expect(content).toContain("1 image attachment omitted");
        // Log WARN should name the UPSTREAM model (the one actually rejecting
        // the image), not the client literal. Otherwise users debug the wrong id.
        const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warnText).toContain("mimo-v2.5-pro");
        expect(warnText).not.toMatch(/model "mimo-v2\.5"/); // not the client literal
      } finally {
        warnSpy.mockRestore();
        rmSync(dropDir, { recursive: true, force: true });
      }
    });

    it("no upstreamModel passed → falls back to req.model (backward compat)", () => {
      const dropDir = mkdtempSync(join(tmpdir(), "mimo2codex-test-"));
      try {
        // No upstreamModel → use req.model (mimo-v2.5-pro), which does NOT
        // support vision → image gets stripped, same as before this fix.
        const chat = reqToChat(visionReq("mimo-v2.5-pro"), { imageDropDir: dropDir });
        const content =
          typeof chat.messages[0].content === "string" ? chat.messages[0].content : "";
        expect(content).toContain("1 image attachment omitted");
      } finally {
        rmSync(dropDir, { recursive: true, force: true });
      }
    });

    it("upstreamModel = `mimo-v2-omni` overrides non-vision client model → image PASSES", () => {
      const chat = reqToChat(visionReq("deepseek-v4-pro"), { upstreamModel: "mimo-v2-omni" });
      const msg = chat.messages[0];
      expect(Array.isArray(msg.content)).toBe(true);
      const parts = msg.content as Array<{ type: string }>;
      expect(parts.some((p) => p.type === "image_url")).toBe(true);
    });
  });

  // Regression: under --no-reasoning, respToResponses writes the reasoning
  // text into `encrypted_content` with an empty `summary`. The next-turn
  // request from Codex echoes that reasoning item back; reqToChat must
  // extract from encrypted_content (not summary) so MiMo / DS V4 get the
  // reasoning_content on the prior assistant message — without this their
  // tool-calling quality degrades into "narration / free-association"
  // instead of actual tool calls.
  it("reasoning item with empty summary + encrypted_content → reasoning_content on assistant message", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "search for cats" }],
        },
        {
          type: "reasoning",
          summary: [], // hidden from terminal — --no-reasoning case
          encrypted_content: "I should call the search tool here",
        } as unknown as ResponsesRequest["input"] extends Array<infer T> ? T : never,
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"cats"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "5 results" },
      ],
    };
    const chat = reqToChat(req);
    const assistantWithTool = chat.messages.find((m) => m.tool_calls?.length) as
      | { role: "assistant"; reasoning_content?: string; tool_calls: unknown[] }
      | undefined;
    expect(assistantWithTool).toBeDefined();
    expect(assistantWithTool!.reasoning_content).toBe("I should call the search tool here");
  });

  // When BOTH encrypted_content and summary are present, prefer
  // encrypted_content — it's the canonical full-trace channel; summary may
  // be truncated by some clients.
  it("reasoning item with both fields prefers encrypted_content", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "x" }] },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary version" }],
          encrypted_content: "full version",
        } as unknown as ResponsesRequest["input"] extends Array<infer T> ? T : never,
        {
          type: "function_call",
          call_id: "c",
          name: "f",
          arguments: "{}",
        },
      ],
    };
    const chat = reqToChat(req);
    const a = chat.messages.find((m) => m.tool_calls?.length) as
      | { reasoning_content?: string }
      | undefined;
    expect(a?.reasoning_content).toBe("full version");
  });
});

describe("reqToChat — reasoning.effort passthrough", () => {
  it("passes Codex reasoning.effort 'high' through as chat.reasoning_effort", () => {
    const req: ResponsesRequest = {
      model: "sensenova-6.7-flash-lite",
      input: [{ type: "message", role: "user", content: "hi" }],
      reasoning: { effort: "high" },
    } as ResponsesRequest;
    const chat = reqToChat(req);
    expect(chat.reasoning_effort).toBe("high");
  });

  it("'minimal' is mapped to 'low' (closest ChatRequest enum)", () => {
    const req: ResponsesRequest = {
      model: "any",
      input: "hi",
      reasoning: { effort: "minimal" },
    } as ResponsesRequest;
    const chat = reqToChat(req);
    expect(chat.reasoning_effort).toBe("low");
  });

  it("when Codex omits reasoning AND forceHighEffort=false (default), do NOT inject effort", () => {
    const req: ResponsesRequest = {
      model: "any",
      input: "hi",
    } as ResponsesRequest;
    const chat = reqToChat(req);
    expect(chat.reasoning_effort).toBeUndefined();
  });

  it("forceHighEffort=true + Codex omits reasoning → inject 'high'", () => {
    const req: ResponsesRequest = {
      model: "any",
      input: "hi",
    } as ResponsesRequest;
    const chat = reqToChat(req, { forceHighEffort: true });
    expect(chat.reasoning_effort).toBe("high");
  });

  it("disableThinking=true + forceHighEffort=true → disableThinking wins, no effort injected", () => {
    const req: ResponsesRequest = {
      model: "any",
      input: "hi",
    } as ResponsesRequest;
    const chat = reqToChat(req, { disableThinking: true, forceHighEffort: true });
    expect(chat.reasoning_effort).toBeUndefined();
    expect(chat.thinking).toEqual({ type: "disabled" });
  });

  it("Codex explicit effort takes precedence even when forceHighEffort=true", () => {
    const req: ResponsesRequest = {
      model: "any",
      input: "hi",
      reasoning: { effort: "low" },
    } as ResponsesRequest;
    const chat = reqToChat(req, { forceHighEffort: true });
    expect(chat.reasoning_effort).toBe("low"); // 客户端意图优先于兜底
  });
});

// Covers the symmetric counterpart of "missing function_call_output …
// placeholder" above. The mirror direction — orphan function_call_output
// items in history (Codex desync after Esc / Ctrl+C, openai/codex#8479) —
// was triggering an unrecoverable DeepSeek 400 (mimo2codex#8). The scrub
// is now in inputItemsToMessages right before ensureToolCallsHaveOutputs.
describe("reqToChat — orphan tool message scrub (PR #10 regression)", () => {
  it("drops a tool message whose tool_call_id has no preceding assistant.tool_calls", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "hi" },
        // Orphan: no assistant.tool_calls before it.
        {
          type: "function_call_output",
          call_id: "call_orphan_001",
          output: "stale",
        },
        { type: "message", role: "user", content: "now do A" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
      ],
    };
    const chat = reqToChat(req);
    const toolMsgs = chat.messages.filter((m) => m.role === "tool");
    // call_orphan_001 must be gone; call_A's output must survive.
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["call_A"]);
    // And the assistant.tool_calls/tool pairing invariant still holds.
    const idxAsst = chat.messages.findIndex(
      (m) => m.role === "assistant" && m.tool_calls?.length
    );
    expect(idxAsst).toBeGreaterThanOrEqual(0);
    expect(chat.messages[idxAsst + 1]?.role).toBe("tool");
    expect(chat.messages[idxAsst + 1]?.tool_call_id).toBe("call_A");
  });

  it("drops a tool message whose tool_call_id does not match the preceding assistant.tool_calls", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
        // Next assistant declares only call_B; a stray output for the
        // earlier call_A reappearing here is an orphan in this scope.
        // We synthesize that scenario with a second turn.
        { type: "message", role: "user", content: "now do B" },
        {
          type: "function_call",
          call_id: "call_B",
          name: "shell",
          arguments: '{"cmd":"B"}',
        },
        // mismatched id — refers to call_A but appears after the B-only assistant turn
        { type: "function_call_output", call_id: "call_A", output: "stale-A" },
        { type: "function_call_output", call_id: "call_B", output: "rb" },
      ],
    };
    const chat = reqToChat(req);
    // call_A output for the FIRST turn must survive; the SECOND occurrence
    // (mismatched, after the B-only assistant) must be dropped.
    const toolMsgs = chat.messages.filter((m) => m.role === "tool");
    const ids = toolMsgs.map((m) => m.tool_call_id);
    // Expect: [call_A (turn 1), call_B (turn 2)] — orphan call_A from turn 2 removed.
    expect(ids).toEqual(["call_A", "call_B"]);
  });

  it("validity window resets on a user message — a tool message after user but before any assistant.tool_calls is dropped", () => {
    // assistant(tool_calls=A) → tool(A) ✓ → user(...) → tool(A again) ✗ orphan
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
        { type: "message", role: "user", content: "anything else?" },
        // After a user message — validity window must reset, so this is orphan.
        { type: "function_call_output", call_id: "call_A", output: "replay" },
      ],
    };
    const chat = reqToChat(req);
    const toolMsgs = chat.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].tool_call_id).toBe("call_A");
    expect(toolMsgs[0].content).toBe("ra");
  });

  it("parallel tool_calls: keeps valid outputs, drops orphan ones in the same window", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A and B in parallel" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        {
          type: "function_call",
          call_id: "call_B",
          name: "shell",
          arguments: '{"cmd":"B"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
        // Orphan: call_GHOST was never declared.
        {
          type: "function_call_output",
          call_id: "call_GHOST",
          output: "noise",
        },
        { type: "function_call_output", call_id: "call_B", output: "rb" },
      ],
    };
    const chat = reqToChat(req);
    const toolMsgs = chat.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["call_A", "call_B"]);
  });

  it("regression: well-formed assistant.tool_calls + tool pair is unchanged", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "do A" },
        {
          type: "function_call",
          call_id: "call_A",
          name: "shell",
          arguments: '{"cmd":"A"}',
        },
        { type: "function_call_output", call_id: "call_A", output: "ra" },
      ],
    };
    const chat = reqToChat(req);
    const idxAsst = chat.messages.findIndex(
      (m) => m.role === "assistant" && m.tool_calls?.length
    );
    expect(idxAsst).toBeGreaterThanOrEqual(0);
    expect(chat.messages[idxAsst].tool_calls?.[0].id).toBe("call_A");
    expect(chat.messages[idxAsst + 1].role).toBe("tool");
    expect(chat.messages[idxAsst + 1].tool_call_id).toBe("call_A");
    expect(chat.messages[idxAsst + 1].content).toBe("ra");
  });

  // ── issue #29 回归 ──────────────────────────────────────────────────────
  // DeepSeek V4 把显式 content:null 当成"两个字段都没"，于是 400
  // "Invalid assistant message: content or tool_calls must be set"。
  // Codex Chrome 插件常发的 reasoning(encrypted_content) + function_call
  // 序列以前会产生这种形状，现在应当省略 content 字段（OpenAI 规范允许
  // tool_calls 存在时 content 缺省）。
  it("reasoning(encrypted_content) + function_call without prior assistant text → no content:null (issue #29)", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "search for cats" },
        {
          type: "reasoning",
          summary: [],
          encrypted_content: "I should call the search tool.",
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: '{"q":"cats"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "5 results" },
      ],
    };
    const chat = reqToChat(req);
    const asst = chat.messages.find((m) => m.role === "assistant");
    expect(asst).toBeDefined();
    // 关键断言 —— content 字段必须缺省，不能为 null。
    expect("content" in (asst as object)).toBe(false);
    expect((asst as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1);
    expect((asst as { reasoning_content?: string }).reasoning_content).toBe(
      "I should call the search tool."
    );
  });

  it("trailing reasoning with no tools and no assistant text emits content:'' not null (issue #29)", () => {
    // 兜底场景：reasoning-only 回合（无 text 无 tools）。OpenAI 规范要求
    // assistant 消息至少有 content 或 tool_calls 之一，所以补空字符串。
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        { type: "message", role: "user", content: "hi" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking…" }],
        },
      ],
    };
    const chat = reqToChat(req);
    const asst = chat.messages.find((m) => m.role === "assistant");
    expect(asst).toEqual({
      role: "assistant",
      content: "",
      reasoning_content: "thinking…",
    });
  });

  // Issue #39: Codex Desktop's connector plugins (GitHub / Canva / HeyGen /
  // Dropbox / Gmail / Google Drive / ...) send `tool.type === "mcp"` over
  // the Responses API. First-party connectors carry `connector_id`;
  // user-configured remote MCP servers carry `server_url`. Chat-Completions
  // upstreams (MiMo / DeepSeek / SenseNova / ...) don't implement MCP, so
  // mimo2codex drops these tools — but the drop must be VISIBLE and the
  // warn must explain the kind so users know how to react.
  //
  // The fallback warn for genuinely-unknown tool types must also include a
  // redacted payload so the next time someone reports a brand-new tool
  // shape we have it pre-instrumented in their log.
  describe("mcp / connector plugin tools (issue #39)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let debugSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
      debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    });

    const allWarnText = (): string =>
      warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const allDebugText = (): string =>
      debugSpy.mock.calls.map((c) => String(c[0])).join("\n");

    it("first-party connector (connector_id) is dropped silently — no user-visible WARN (the advisory system note handles it)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "GitHub",
            connector_id: "connector_github",
            authorization: "shhh-oauth-token-do-not-leak-001",
            require_approval: "never",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toBeUndefined();
      const warnText = allWarnText();
      // No WARN-level noise — connector is silent at WARN level.
      expect(warnText).not.toMatch(/connector/i);
      expect(warnText).not.toMatch(/mcp/i);
      // Optionally surfaced at DEBUG for maintainers using MIMO2CODEX_VERBOSE=1.
      const debugText = allDebugText();
      expect(debugText).toMatch(/GitHub/);
      // OAuth token must never appear — neither WARN nor DEBUG.
      expect(warnText).not.toContain("shhh-oauth-token-do-not-leak-001");
      expect(debugText).not.toContain("shhh-oauth-token-do-not-leak-001");
    });

    it("remote MCP server (server_url) is dropped with a short WARN (Phase B bridging not yet shipped)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "my-mcp-issue39-srv",
            server_url: "https://mcp.issue39.example.com/v1",
            authorization: "Bearer secret-bearer-issue39-002",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toBeUndefined();
      const text = allWarnText();
      expect(text).toMatch(/remote MCP tool/);
      expect(text).toMatch(/my-mcp-issue39-srv/);
      expect(text).not.toContain("secret-bearer-issue39-002");
    });

    it("truly unknown tool type → short WARN (no payload); payload goes to DEBUG only", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "totally_unknown_v2_test_xyz",
            authorization: "secret-token-do-not-leak-abc",
            api_key: "ak-leak-test-zzz",
            visible_field: "should-be-visible",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toBeUndefined();
      const warnText = allWarnText();
      // WARN is short: names the type, does NOT include payload.
      expect(warnText).toMatch(/totally_unknown_v2_test_xyz/);
      expect(warnText).not.toMatch(/payload/);
      // DEBUG has the redacted payload for issue reports.
      const debugText = allDebugText();
      expect(debugText).toMatch(/totally_unknown_v2_test_xyz/);
      expect(debugText).toMatch(/payload/);
      expect(debugText).toMatch(/"authorization":"\*\*\*"/);
      expect(debugText).toMatch(/"api_key":"\*\*\*"/);
      expect(debugText).toContain("should-be-visible");
      // Secrets must never leak — neither channel.
      expect(warnText).not.toContain("secret-token-do-not-leak-abc");
      expect(debugText).not.toContain("secret-token-do-not-leak-abc");
      expect(warnText).not.toContain("ak-leak-test-zzz");
      expect(debugText).not.toContain("ak-leak-test-zzz");
    });

    it("nested secrets inside unknown tool payload are also redacted (in DEBUG)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "future_nested_type_qqq",
            metadata: {
              client_secret: "nested-secret-do-not-leak-qq",
              harmless: "fine-to-show",
            },
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      reqToChat(req);
      const warnText = allWarnText();
      const debugText = allDebugText();
      expect(warnText).not.toContain("nested-secret-do-not-leak-qq");
      expect(debugText).not.toContain("nested-secret-do-not-leak-qq");
      expect(debugText).toMatch(/"client_secret":"\*\*\*"/);
      expect(debugText).toContain("fine-to-show");
    });

    it("mcp + function mixed → only function survives; the function tool's name passes through", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "Canva-mixed-test",
            connector_id: "connector_canva_mixedtest",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "shell_mixed_test", parameters: { type: "object" } },
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(1);
      const fn = chat.tools![0] as { type: string; function: { name: string } };
      expect(fn.type).toBe("function");
      expect(fn.function.name).toBe("shell_mixed_test");
    });

    it("all-mcp (first-party) request → silent at WARN level (advisory note covers it; no summary noise)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "HeyGen-alldrop-A",
            connector_id: "connector_heygen_alldrop_a",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          {
            type: "mcp",
            server_label: "HeyGen-alldrop-B",
            connector_id: "connector_heygen_alldrop_b",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toBeUndefined();
      const warnText = allWarnText();
      // Removed by design — advisory note + per-type handling are enough.
      expect(warnText).not.toMatch(/all \d+ client tool\(s\)/);
      expect(warnText).not.toMatch(/were dropped/);
      // Phase C advisory note is still injected (verified separately in the
      // "mcp first-party-connector advisory note" describe block below).
    });
  });

  // Phase C of issue #39: first-party Codex Desktop connectors (GitHub /
  // Canva / HeyGen / Dropbox / Gmail / Google Drive — `mcp` + `connector_id`)
  // physically can't be bridged by a third-party proxy. To avoid the model
  // generating phantom calls to non-existent tools (which Codex Desktop
  // would then surface as "unsupported call"), we inject a system-prompt
  // advisory note when these connectors are present, naming each one and
  // telling the model to fall back to `shell` + a CLI equivalent.
  describe("mcp first-party-connector advisory note (issue #39 Phase C)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    const findAdvisorySysMsg = (
      chat: ReturnType<typeof reqToChat>
    ): { role: "system"; content: string } | undefined => {
      return chat.messages.find(
        (m): m is { role: "system"; content: string } =>
          m.role === "system" &&
          typeof m.content === "string" &&
          m.content.includes("connector plugin")
      );
    };

    it("connector_id present → injects a system advisory naming the connector with shell-fallback guidance", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "GitHub-phaseC-test",
            connector_id: "connector_github_phasec",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      const advisory = findAdvisorySysMsg(chat);
      expect(advisory).toBeDefined();
      expect(advisory!.content).toMatch(/GitHub-phaseC-test/);
      // Should tell the model what to do instead of pretending the connector works.
      expect(advisory!.content).toMatch(/shell/i);
      // Should explicitly forbid pretending to call the connector.
      expect(advisory!.content).toMatch(/do not pretend|do not attempt|no tool/i);
    });

    it("multiple connector_ids → single advisory lists ALL connectors", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "GitHub-multi-A",
            connector_id: "connector_github_multi_a",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          {
            type: "mcp",
            server_label: "Canva-multi-B",
            connector_id: "connector_canva_multi_b",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          {
            type: "mcp",
            server_label: "HeyGen-multi-C",
            connector_id: "connector_heygen_multi_c",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      const allSystem = chat.messages
        .filter((m) => m.role === "system")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" | ");
      // exactly one advisory system message
      const advisoryCount = chat.messages.filter(
        (m) =>
          m.role === "system" &&
          typeof m.content === "string" &&
          m.content.includes("connector plugin")
      ).length;
      expect(advisoryCount).toBe(1);
      expect(allSystem).toMatch(/GitHub-multi-A/);
      expect(allSystem).toMatch(/Canva-multi-B/);
      expect(allSystem).toMatch(/HeyGen-multi-C/);
    });

    it("connector_id WITH req.instructions → advisory inserted right after instructions", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        instructions: "You are a helpful coding agent named Probe-PhaseC.",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "Dropbox-insertpos-test",
            connector_id: "connector_dropbox_insertpos",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      // First message MUST be the original instructions (preserve user prompt).
      expect(chat.messages[0]).toEqual({
        role: "system",
        content: "You are a helpful coding agent named Probe-PhaseC.",
      });
      // Second message MUST be the connector advisory.
      const second = chat.messages[1];
      expect(second.role).toBe("system");
      expect(typeof second.content).toBe("string");
      expect(second.content as string).toMatch(/connector plugin/);
      expect(second.content as string).toMatch(/Dropbox-insertpos-test/);
    });

    it("connector_id WITHOUT req.instructions → advisory is the first message", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "Gmail-noinstr-test",
            connector_id: "connector_gmail_noinstr",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      // First message: the advisory itself (no user instructions to slot after).
      const first = chat.messages[0];
      expect(first.role).toBe("system");
      expect(typeof first.content).toBe("string");
      expect(first.content as string).toMatch(/connector plugin/);
      expect(first.content as string).toMatch(/Gmail-noinstr-test/);
    });

    it("server_url-only mcp (no connector_id) → NO advisory injected (Phase B's domain)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "selfhosted-mcp-noad",
            server_url: "https://mcp.noad.example.com",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      const advisory = findAdvisorySysMsg(chat);
      expect(advisory).toBeUndefined();
    });

    it("no mcp tools at all → NO advisory injected", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          { type: "function", name: "shell_nophasec", parameters: { type: "object" } },
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      const advisory = findAdvisorySysMsg(chat);
      expect(advisory).toBeUndefined();
    });

    it("connector_id + function tool → advisory present AND function tool survives", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          {
            type: "mcp",
            server_label: "Canva-mixed-phaseC",
            connector_id: "connector_canva_mixed_phasec",
          } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "shell_mixed_phaseC", parameters: { type: "object" } },
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      // Function tool survived.
      expect(chat.tools).toHaveLength(1);
      const fn = chat.tools![0] as { type: string; function: { name: string } };
      expect(fn.function.name).toBe("shell_mixed_phaseC");
      // Advisory present.
      const advisory = findAdvisorySysMsg(chat);
      expect(advisory).toBeDefined();
      expect(advisory!.content).toMatch(/Canva-mixed-phaseC/);
    });
  });

  // Issue #41: Codex Desktop sends a `tool_search` builtin that exposes
  // deferred tools to the model via BM25 search. The tool is shaped like a
  // standard function (name="tool_search", description, parameters) but uses
  // `type: "tool_search"` + `execution: "client"` — Codex Desktop handles
  // the call locally and returns matching tools in the next turn. Without
  // explicit translation, mimo2codex drops it and the model can't discover
  // any deferred tools; the downstream symptom is "dropped orphan tool
  // message" warns when Codex Desktop returns function_call_outputs whose
  // tool_call_ids never made it into our request history.
  describe("tool_search tool (issue #41)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    const realToolSearchPayload = {
      type: "tool_search",
      execution: "client",
      description:
        "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum number of tools to return (defaults to 8)." },
          query: { type: "string", description: "Search query for deferred tools." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    };

    it("tool_search → translated to a function tool named \"tool_search\" with description + parameters preserved", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          realToolSearchPayload as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(1);
      const fn = chat.tools![0] as {
        type: string;
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      };
      expect(fn.type).toBe("function");
      expect(fn.function.name).toBe("tool_search");
      expect(fn.function.description).toMatch(/Tool discovery/);
      expect(fn.function.parameters).toEqual(realToolSearchPayload.parameters);
    });

    it("tool_search does NOT trigger the `unsupported tool type` fallback warn", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          realToolSearchPayload as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      reqToChat(req);
      const allWarns = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(allWarns).not.toMatch(/unsupported tool type "tool_search"/);
      expect(allWarns).not.toMatch(/all \d+ client tool\(s\) were dropped/);
    });

    it("tool_search alongside function + local_shell → all three survive, tool_search is one of them", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          realToolSearchPayload as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
          { type: "function", name: "spawn_agent_test_i41", parameters: { type: "object" } },
          { type: "local_shell" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(3);
      const names = (chat.tools as Array<{ type: string; function?: { name?: string } }>)
        .filter((t) => t.type === "function")
        .map((t) => t.function?.name)
        .sort();
      expect(names).toEqual(["shell", "spawn_agent_test_i41", "tool_search"]);
    });

    it("tool_search without a description or parameters still translates without throwing", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: "x",
        tools: [
          { type: "tool_search" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        ] as ResponsesRequest["tools"],
      };
      const chat = reqToChat(req);
      expect(chat.tools).toHaveLength(1);
      const fn = chat.tools![0] as { type: string; function: { name: string } };
      expect(fn.function.name).toBe("tool_search");
    });
  });

  describe("historical function_call arguments sanitization (long-conversation 400 defense)", () => {
    // Repro for the "unexpected end of data: line 1 column 46 (char 45)" 400
    // that strict upstreams (MiMo / DeepSeek / SenseNova) throw once a Codex
    // session has accumulated a truncated tool_call.arguments. The proxy now
    // salvages malformed arguments to "{}" on the way out so the request body
    // is always well-formed.
    it("valid JSON arguments pass through unchanged (zero-overhead happy path)", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "ls" }] },
          {
            type: "function_call",
            call_id: "c1",
            name: "shell",
            arguments: '{"command":["ls"]}',
          },
          { type: "function_call_output", call_id: "c1", output: "a\nb" },
        ],
      };
      const chat = reqToChat(req);
      const assistant = chat.messages.find((m) => m.role === "assistant")!;
      expect(assistant.tool_calls![0].function.arguments).toBe('{"command":["ls"]}');
    });

    it("truncated JSON arguments are salvaged to '{}'", () => {
      const spy = vi.spyOn(log, "warn").mockImplementation(() => {});
      const truncated =
        '{"command":["bash","-lc","echo a"],"workdir":'; // breaks at char 45
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "?" }] },
          {
            type: "function_call",
            call_id: "c1",
            name: "shell",
            arguments: truncated,
          },
          { type: "function_call_output", call_id: "c1", output: "x" },
        ],
      };
      const chat = reqToChat(req);
      const assistant = chat.messages.find((m) => m.role === "assistant")!;
      expect(assistant.tool_calls![0].function.arguments).toBe("{}");
      expect(spy).toHaveBeenCalledOnce();
      const warnMsg = spy.mock.calls[0][0] as string;
      expect(warnMsg).toContain('name="shell"');
      expect(warnMsg).toContain("salvaging malformed historical tool_call arguments");
      spy.mockRestore();
    });

    it("empty string arguments become '{}'", () => {
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: "?" },
          { type: "function_call", call_id: "c1", name: "ping", arguments: "" },
          { type: "function_call_output", call_id: "c1", output: "ok" },
        ],
      };
      const chat = reqToChat(req);
      const assistant = chat.messages.find((m) => m.role === "assistant")!;
      expect(assistant.tool_calls![0].function.arguments).toBe("{}");
    });

    it("salvage preserves the assistant↔tool message pairing (no orphan)", () => {
      // Critical regression: if sanitization dropped the whole tool_call we
      // would orphan the matching `tool` message and DeepSeek V4 would 400
      // with "tool message has no preceding tool_calls". Keep structure intact.
      const req: ResponsesRequest = {
        model: "mimo-v2.5-pro",
        input: [
          { type: "message", role: "user", content: "?" },
          {
            type: "function_call",
            call_id: "c_broken",
            name: "shell",
            arguments: '{"command":["bash","-lc","echo a"],"work', // truncated
          },
          { type: "function_call_output", call_id: "c_broken", output: "x" },
        ],
      };
      const chat = reqToChat(req);
      const assistant = chat.messages.find((m) => m.role === "assistant")!;
      const tool = chat.messages.find((m) => m.role === "tool")!;
      expect(assistant.tool_calls).toHaveLength(1);
      expect(assistant.tool_calls![0].id).toBe("c_broken");
      expect(assistant.tool_calls![0].function.arguments).toBe("{}");
      expect(tool.tool_call_id).toBe("c_broken");
    });
  });
});
