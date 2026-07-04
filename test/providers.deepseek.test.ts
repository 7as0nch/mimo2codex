import { describe, expect, it } from "vitest";
import { deepseek } from "../src/providers/deepseek.js";
import { mimo } from "../src/providers/mimo.js";
import type { ChatRequest, ResponsesRequest } from "../src/translate/types.js";

const dsCtx = {
  runtime: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-x", flags: {} },
  exposeReasoning: true,
};

const mimoCtx = {
  runtime: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "sk-x", flags: { isTokenPlan: false } },
  exposeReasoning: true,
};

describe("deepseek provider", () => {
  it("preprocessResponses injects thinking.enabled + reasoning_effort=high by default", () => {
    const req: ResponsesRequest = { model: "deepseek-v4-pro", input: "hello" };
    const chat = deepseek.preprocessResponses(req, dsCtx);
    expect(chat.thinking).toEqual({ type: "enabled" });
    expect(chat.reasoning_effort).toBe("high");
    // enable_thinking (MiMo-style legacy field) must still be stripped.
    expect(chat.enable_thinking).toBeUndefined();
  });

  it("preprocessResponses preserves client-supplied thinking.disabled (no default override)", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: "hello",
    };
    // Simulate a future client that already negotiates `thinking` upstream.
    const chat = deepseek.preprocessResponses(req, dsCtx);
    chat.thinking = { type: "disabled" };
    const out = deepseek.preprocessChat(chat, dsCtx);
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("preprocessResponses strips temperature/top_p/penalties in thinking mode", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: "hi",
      temperature: 0.5,
      top_p: 0.9,
    };
    const chat = deepseek.preprocessResponses(req, dsCtx);
    expect(chat.thinking?.type).toBe("enabled");
    expect(chat.temperature).toBeUndefined();
    expect(chat.top_p).toBeUndefined();
    expect(chat.presence_penalty).toBeUndefined();
    expect(chat.frequency_penalty).toBeUndefined();
  });

  it("preprocessResponses drops web_search builtin (DeepSeek doesn't have one)", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: "search for cats",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
        { type: "function", name: "shell", parameters: { type: "object" } },
      ] as ResponsesRequest["tools"],
    };
    const chat = deepseek.preprocessResponses(req, dsCtx);
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools![0].type).toBe("function");
  });

  it("preprocessResponses respects the client's parallel_tool_calls (no force)", () => {
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: "hi",
      parallel_tool_calls: false,
    };
    const chat = deepseek.preprocessResponses(req, dsCtx);
    expect(chat.parallel_tool_calls).toBe(false);
  });

  it("preprocessChat preserves thinking, strips enable_thinking, injects reasoning_effort default", () => {
    const body: ChatRequest = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
      enable_thinking: true,
    };
    const out = deepseek.preprocessChat(body, dsCtx);
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.enable_thinking).toBeUndefined();
    expect(out.reasoning_effort).toBe("high");
    // original is not mutated
    expect(body.enable_thinking).toBe(true);
  });

  it("preprocessChat PRESERVES reasoning_content for V4 family (V4 requires it back in thinking mode)", () => {
    const body: ChatRequest = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: "first answer",
          reasoning_content: "let me think...",
        },
        { role: "user", content: "follow-up" },
      ],
    };
    const out = deepseek.preprocessChat(body, dsCtx);
    expect(out.messages[1].reasoning_content).toBe("let me think...");
    expect(out.messages[1].content).toBe("first answer");
  });

  it("preprocessChat STRIPS reasoning_content for legacy deepseek-reasoner (R1 rejects it)", () => {
    const body: ChatRequest = {
      model: "deepseek-reasoner",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "a",
          reasoning_content: "thoughts",
        },
        { role: "user", content: "follow-up" },
      ],
    };
    const out = deepseek.preprocessChat(body, dsCtx);
    expect(out.messages[1].reasoning_content).toBeUndefined();
    expect(out.messages[1].content).toBe("a");
    // Original input is not mutated.
    expect(body.messages[1].reasoning_content).toBe("thoughts");
  });

  it("preprocessResponses preserves reasoning_content for V4 family (multi-turn requirement)", () => {
    // Codex echoes prior reasoning items in the next request's input. reqToChat
    // re-emits them as `reasoning_content` on the assistant message. The V4
    // family demands this on every prior turn — strip would 400 the next call.
    const req: ResponsesRequest = {
      model: "deepseek-v4-pro",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "search for cats" }],
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should call search" }],
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
    const chat = deepseek.preprocessResponses(req, dsCtx);
    const assistantWithTool = chat.messages.find((m) => m.tool_calls?.length);
    expect(assistantWithTool).toBeDefined();
    expect(assistantWithTool!.reasoning_content).toBe("I should call search");
    expect(assistantWithTool!.tool_calls![0].function.name).toBe("search");
  });

  it("preprocessResponses still STRIPS reasoning_content when client model is deepseek-reasoner", () => {
    const req: ResponsesRequest = {
      model: "deepseek-reasoner",
      input: [
        { type: "message", role: "user", content: "search for cats" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thoughts" }],
        },
        { type: "message", role: "user", content: "follow-up" },
      ],
    };
    const chat = deepseek.preprocessResponses(req, dsCtx);
    for (const m of chat.messages) {
      expect(m.reasoning_content).toBeUndefined();
    }
  });

  it("enhanceError returns null (no DS-specific error mapping yet)", () => {
    expect(deepseek.enhanceError({ status: 400, snippet: "anything" })).toBeNull();
    expect(deepseek.enhanceError({ status: 401 })).toBeNull();
  });

  it("metadata: shortcut, env keys, default model match the spec", () => {
    expect(deepseek.shortcut).toBe("ds");
    expect(deepseek.envKeys).toEqual(["DS_API_KEY", "DEEPSEEK_API_KEY"]);
    expect(deepseek.defaultModel).toBe("deepseek-v4-pro");
    expect(deepseek.defaultBaseUrl).toBe("https://api.deepseek.com/v1");
  });
});

describe("mimo provider preprocessResponses retains MiMo specifics", () => {
  it("forces parallel_tool_calls", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "hi",
      parallel_tool_calls: false,
    };
    const chat = mimo.preprocessResponses(req, mimoCtx);
    expect(chat.parallel_tool_calls).toBe(true);
  });

  it("drops web_search by DEFAULT (toggle off) even when not on token-plan", () => {
    // Web search is opt-in now: without webSearchEnabled the tool is stripped,
    // so a sk- account without the (separately-billed) plugin can't 400.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = mimo.preprocessResponses(req, mimoCtx);
    expect(chat.tools).toBeUndefined();
  });

  it("forwards web_search when the toggle is ON (and not token-plan)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const chat = mimo.preprocessResponses(req, { ...mimoCtx, webSearchEnabled: true });
    expect(chat.tools).toHaveLength(1);
    expect(chat.tools![0].type).toBe("web_search");
  });

  it("strips web_search when isTokenPlan (even with the toggle on)", () => {
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: "x",
      tools: [
        { type: "web_search_preview" } as unknown as ResponsesRequest["tools"] extends Array<infer T> ? T : never,
      ] as ResponsesRequest["tools"],
    };
    const ctx = {
      ...mimoCtx,
      webSearchEnabled: true,
      runtime: { ...mimoCtx.runtime, flags: { isTokenPlan: true } },
    };
    const chat = mimo.preprocessResponses(req, ctx);
    expect(chat.tools).toBeUndefined();
  });

  it("enhanceError surfaces web_search plugin hint on 400 with marker", () => {
    const err = mimo.enhanceError({
      status: 400,
      snippet:
        "web search tool found in the request body, but webSearchEnabled is false",
    });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("web_search_plugin_not_activated");
    expect(err!.message).toMatch(/Web Search Plugin/);
  });

  it("enhanceError returns null for unrelated 400 errors", () => {
    expect(mimo.enhanceError({ status: 400, snippet: "Param Incorrect" })).toBeNull();
    expect(mimo.enhanceError({ status: 401 })).toBeNull();
  });

  it("preprocessResponses preserves reasoning_content (MiMo needs it back in multi-turn)", () => {
    // The opposite of the DS strip: MiMo's official guidance is to re-inject
    // prior reasoning_content. Guard against accidental cross-contamination.
    const req: ResponsesRequest = {
      model: "mimo-v2.5-pro",
      input: [
        { type: "message", role: "user", content: "search for cats" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should call search" }],
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
    const chat = mimo.preprocessResponses(req, mimoCtx);
    const assistantWithReasoning = chat.messages.find((m) => m.reasoning_content);
    expect(assistantWithReasoning).toBeDefined();
    expect(assistantWithReasoning!.reasoning_content).toBe("I should call search");
  });

  it("M2: injects thinking.enabled for all live reasoning models", () => {
    for (const model of ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-pro-ultraspeed"]) {
      const chat = mimo.preprocessResponses(
        { model, input: "hi" },
        { ...mimoCtx, upstreamModel: model }
      );
      expect(chat.thinking?.type, `${model} should default to thinking.enabled`).toBe("enabled");
    }
  });

  it("M2: retired mimo-v2-flash aliases to mimo-v2.5 and now DEFAULTS thinking enabled", () => {
    // Behavior change from the v2 retirement: flash used to default thinking
    // OFF, but its official replacement mimo-v2.5 defaults thinking ON. The
    // client still sends the old name; upstream is the aliased v2.5, so the
    // v2.5 default applies (normalization keys off ctx.upstreamModel).
    const chat = mimo.preprocessResponses(
      { model: "mimo-v2-flash", input: "hi" },
      { ...mimoCtx, upstreamModel: "mimo-v2.5" }
    );
    expect(chat.thinking?.type).toBe("enabled");
  });

  it("M3: strips temperature AND top_p on the v2.5 family when thinking is enabled", () => {
    for (const model of ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2.5-pro-ultraspeed"]) {
      const chat = mimo.preprocessResponses(
        { model, input: "hi", temperature: 0.5, top_p: 0.7 },
        { ...mimoCtx, upstreamModel: model }
      );
      expect(chat.thinking?.type).toBe("enabled");
      expect(chat.temperature, `${model} temperature stripped`).toBeUndefined();
      expect(chat.top_p, `${model} top_p stripped`).toBeUndefined();
    }
  });

  it("M3: retired mimo-v2-pro aliases to mimo-v2.5-pro and strips temperature/top_p", () => {
    // The old "v2-pro keeps its temperature" behavior is gone — v2-pro now
    // resolves to mimo-v2.5-pro, which forces temperature:1.0 / top_p:0.95 in
    // thinking mode, so we strip both.
    const chat = mimo.preprocessResponses(
      { model: "mimo-v2-pro", input: "hi", temperature: 0.3, top_p: 0.7 },
      { ...mimoCtx, upstreamModel: "mimo-v2.5-pro" }
    );
    expect(chat.thinking?.type).toBe("enabled");
    expect(chat.temperature).toBeUndefined();
    expect(chat.top_p).toBeUndefined();
  });

  it("M4: strips tool_choice when set to a non-auto value", () => {
    const body: ChatRequest = {
      model: "mimo-v2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    };
    const out = mimo.preprocessChat(body, mimoCtx);
    expect(out.tool_choice).toBeUndefined();
  });

  it("M4: keeps tool_choice when explicitly 'auto'", () => {
    const body: ChatRequest = {
      model: "mimo-v2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
    };
    const out = mimo.preprocessChat(body, mimoCtx);
    expect(out.tool_choice).toBe("auto");
  });

  it("M5: catalog declares maxOutputTokens for every builtin model", () => {
    for (const m of mimo.builtinModels) {
      expect(m.maxOutputTokens, `${m.id} should have maxOutputTokens`).toBeGreaterThan(0);
    }
  });

  it("inferBaseUrlFromKey routes tp-* keys to the token-plan host", () => {
    expect(mimo.inferBaseUrlFromKey?.("tp-xxx")).toBe(
      "https://token-plan-cn.xiaomimimo.com/v1"
    );
    expect(mimo.inferBaseUrlFromKey?.("sk-xxx")).toBe("https://api.xiaomimimo.com/v1");
    expect(mimo.inferBaseUrlFromKey?.("anonymous")).toBeNull();
  });

  it("DeepSeek does not override base url from key prefix", () => {
    const inferred = (
      // Optional method — call only if defined.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (deepseek as any).inferBaseUrlFromKey?.("sk-xxx") ?? null
    );
    expect(inferred).toBeNull();
  });
});
