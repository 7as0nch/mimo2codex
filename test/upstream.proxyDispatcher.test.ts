import { describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import {
  installProxyDispatcherFromEnv,
  redactProxyUrl,
} from "../src/upstream/proxyDispatcher.js";

function makeStub(): { fn: (d: Dispatcher) => void; calls: Dispatcher[] } {
  const calls: Dispatcher[] = [];
  return { fn: (d) => calls.push(d), calls };
}

describe("installProxyDispatcherFromEnv", () => {
  it("returns no-env but still installs a (non-proxy) timeout dispatcher when no proxy env is set", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv({}, { setDispatcher: stub.fn });
    expect(status).toMatchObject({ enabled: false, reason: "no-env" });
    // The timeout fix is global — a plain Agent is installed even without a proxy.
    expect(stub.calls).toHaveLength(1);
    expect(status.headersTimeoutMs).toBe(600_000);
    expect(status.bodyTimeoutMs).toBe(600_000);
  });

  it("installs dispatcher and returns status when HTTPS_PROXY is set", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      { HTTPS_PROXY: "http://proxy.local:8080" },
      { setDispatcher: stub.fn }
    );
    expect(status.enabled).toBe(true);
    expect(status.httpsProxy).toBe("http://proxy.local:8080");
    expect(status.reason).toBeUndefined();
    expect(stub.calls).toHaveLength(1);
  });

  it("recognises lowercase aliases (https_proxy / http_proxy / no_proxy)", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      {
        https_proxy: "http://lower.local:1080",
        http_proxy: "http://lower.local:1080",
        no_proxy: "localhost,127.0.0.1",
      },
      { setDispatcher: stub.fn }
    );
    expect(status.enabled).toBe(true);
    expect(status.httpsProxy).toBe("http://lower.local:1080");
    expect(status.httpProxy).toBe("http://lower.local:1080");
    expect(status.noProxy).toBe("localhost,127.0.0.1");
    expect(stub.calls).toHaveLength(1);
  });

  it("prefers uppercase env vars when both cases are present (curl convention)", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      {
        HTTPS_PROXY: "http://upper.local:8080",
        https_proxy: "http://lower.local:1080",
      },
      { setDispatcher: stub.fn }
    );
    expect(status.httpsProxy).toBe("http://upper.local:8080");
  });

  it("opts out of the proxy when MIMO2CODEX_NO_PROXY_FROM_ENV is set, but still installs a timeout dispatcher", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      {
        HTTPS_PROXY: "http://proxy.local:8080",
        MIMO2CODEX_NO_PROXY_FROM_ENV: "1",
      },
      { setDispatcher: stub.fn }
    );
    expect(status).toMatchObject({ enabled: false, reason: "opted-out" });
    // Opt-out disables proxy following, but the global timeout fix still applies
    // — a plain (non-proxy) Agent is installed.
    expect(stub.calls).toHaveLength(1);
  });

  it("reads configurable upstream timeouts from env (0 = disabled)", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      {
        MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS: "120000",
        MIMO2CODEX_UPSTREAM_BODY_TIMEOUT_MS: "0",
      },
      { setDispatcher: stub.fn }
    );
    expect(status.headersTimeoutMs).toBe(120_000);
    expect(status.bodyTimeoutMs).toBe(0);
    expect(stub.calls).toHaveLength(1);
  });

  it("falls back to the default timeout on a non-numeric/negative env value", () => {
    const stub = makeStub();
    const status = installProxyDispatcherFromEnv(
      {
        MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS: "not-a-number",
        MIMO2CODEX_UPSTREAM_BODY_TIMEOUT_MS: "-5",
      },
      { setDispatcher: stub.fn }
    );
    expect(status.headersTimeoutMs).toBe(600_000);
    expect(status.bodyTimeoutMs).toBe(600_000);
  });

  it("defaults setDispatcher to undici.setGlobalDispatcher when not injected", async () => {
    // Smoke-test: with HTTPS_PROXY set and no stub, the call goes to the real
    // setGlobalDispatcher. We verify by observing the global dispatcher
    // changed; reset it afterwards so it doesn't leak across tests.
    const undici = await import("undici");
    const before = undici.getGlobalDispatcher();
    try {
      const status = installProxyDispatcherFromEnv({ HTTPS_PROXY: "http://real.local:9" });
      expect(status.enabled).toBe(true);
      expect(undici.getGlobalDispatcher()).not.toBe(before);
    } finally {
      undici.setGlobalDispatcher(before);
    }
  });
});

describe("redactProxyUrl", () => {
  it("masks the password in a userinfo URL", () => {
    expect(redactProxyUrl("http://user:secret@p:8080")).toBe("http://user:***@p:8080/");
  });

  it("leaves a passwordless URL untouched", () => {
    expect(redactProxyUrl("http://p:8080/")).toBe("http://p:8080/");
  });

  it("returns the input as-is when not a parseable URL", () => {
    expect(redactProxyUrl("not a url")).toBe("not a url");
  });

  it("returns undefined for undefined", () => {
    expect(redactProxyUrl(undefined)).toBeUndefined();
  });
});

// Keep vi referenced so eslint/tsc don't complain about an unused import in
// case the smoke test path changes.
void vi;
