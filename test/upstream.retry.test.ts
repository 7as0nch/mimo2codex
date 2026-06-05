import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callOpenAICompat,
  UpstreamError,
  type UpstreamConfig,
} from "../src/upstream/openaiCompatClient.js";
import type { ChatRequest } from "../src/translate/types.js";

const baseCfg: UpstreamConfig = {
  baseUrl: "http://upstream.test/v1",
  apiKey: "sk-test",
  userAgent: "mimo2codex-test",
  // Tiny base so retries don't slow the suite.
  retryBaseMs: 1,
  maxRetries: 3,
};

const chat: ChatRequest = { model: "m", messages: [{ role: "user", content: "hi" }] };

function jsonOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream retry / 429 fallback", () => {
  it("retries a 429 and succeeds once the upstream recovers", async () => {
    const calls: number[] = [];
    const fake = vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length < 3) return new Response("rate limited", { status: 429 });
      return jsonOk();
    });
    vi.stubGlobal("fetch", fake);

    const res = await callOpenAICompat(baseCfg, chat, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(3); // 429, 429, 200
  });

  it("gives up after maxRetries and throws the 429 with its code", async () => {
    const fake = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fake);

    await expect(
      callOpenAICompat({ ...baseCfg, maxRetries: 2 }, chat, new AbortController().signal)
    ).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    expect(fake).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("uses a larger default retry budget so a sustained 429 still recovers", async () => {
    // No maxRetries on the cfg and no env override → exercises the built-in
    // default. A multi-second quota limit must outlast more than the old 3
    // retries; here the upstream stays 429 for 5 attempts then recovers.
    let n = 0;
    const fake = vi.fn(async () => {
      if (++n < 6) return new Response("rate limited", { status: 429 });
      return jsonOk();
    });
    vi.stubGlobal("fetch", fake);
    const res = await callOpenAICompat(
      {
        baseUrl: baseCfg.baseUrl,
        apiKey: baseCfg.apiKey,
        userAgent: baseCfg.userAgent,
        retryBaseMs: 1, // keep the suite fast; only the COUNT matters here
      },
      chat,
      new AbortController().signal
    );
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(6); // initial + 5 retries, all within default budget
  });

  it("retries transient 503 then succeeds", async () => {
    let n = 0;
    const fake = vi.fn(async () => (++n === 1 ? new Response("busy", { status: 503 }) : jsonOk()));
    vi.stubGlobal("fetch", fake);
    const res = await callOpenAICompat(baseCfg, chat, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-retryable 400", async () => {
    const fake = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fake);
    await expect(
      callOpenAICompat(baseCfg, chat, new AbortController().signal)
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure then succeeds", async () => {
    let n = 0;
    const fake = vi.fn(async () => {
      if (++n === 1) throw new Error("ECONNREFUSED");
      return jsonOk();
    });
    vi.stubGlobal("fetch", fake);
    const res = await callOpenAICompat(baseCfg, chat, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("honors a numeric Retry-After header (and still recovers)", async () => {
    let n = 0;
    const fake = vi.fn(async () =>
      ++n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : jsonOk()
    );
    vi.stubGlobal("fetch", fake);
    const res = await callOpenAICompat(baseCfg, chat, new AbortController().signal);
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("aborts during backoff without further attempts", async () => {
    const ac = new AbortController();
    const fake = vi.fn(async () => {
      // abort right after the first 429 is returned, while we're about to sleep
      queueMicrotask(() => ac.abort());
      return new Response("rate limited", { status: 429 });
    });
    vi.stubGlobal("fetch", fake);
    await expect(callOpenAICompat({ ...baseCfg, retryBaseMs: 200 }, chat, ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
