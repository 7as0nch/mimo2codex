// 出站代理识别 + 全局上游超时配置：Node 原生 fetch（undici）不读
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY，也默认给 headersTimeout/bodyTimeout 各 300s。
// 这里在启动早期安装一个全局 dispatcher：
//   • 有代理 env（且未 opt-out）→ EnvHttpProxyAgent，让上游 fetch 行为与 curl 一致；
//   • 否则 → 普通 Agent。
// 两种情况都带上可配置的 headersTimeout/bodyTimeout（默认 10min），避免大上下文 /
// 大图片导致首 token 迟迟不来时，undici 在 300s 处直接掐断、把 Codex 也带断
// （"stream disconnected before completion"，见 issue #65）。
import {
  Agent,
  EnvHttpProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

// 默认 10 分钟，给大上下文 / 多模态大请求体的 prefill 留足时间。0 = 关闭超时。
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000;

export interface ProxyStatus {
  enabled: boolean;
  /** 解释 enabled=false：用户 opt-out 还是 env 本来就没设 */
  reason?: "no-env" | "opted-out";
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /** 实际生效的 undici headersTimeout（ms，0=关闭），用于 banner / 日志 */
  headersTimeoutMs: number;
  /** 实际生效的 undici bodyTimeout（ms，0=关闭） */
  bodyTimeoutMs: number;
}

export interface InstallOptions {
  /** 测试注入：默认走真正的 undici.setGlobalDispatcher */
  setDispatcher?: (d: Dispatcher) => void;
}

// 解析超时 env：非负有限整数才生效（含 0 = 关闭超时），否则回退默认值。
function parseTimeoutMs(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.trunc(n);
}

export function installProxyDispatcherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: InstallOptions = {}
): ProxyStatus {
  const headersTimeoutMs = parseTimeoutMs(
    env.MIMO2CODEX_UPSTREAM_HEADERS_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS
  );
  const bodyTimeoutMs = parseTimeoutMs(
    env.MIMO2CODEX_UPSTREAM_BODY_TIMEOUT_MS,
    DEFAULT_UPSTREAM_TIMEOUT_MS
  );
  const agentOpts = { headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs };
  const set = opts.setDispatcher ?? setGlobalDispatcher;

  // opt-out：shell 里为 curl/git 常驻 HTTPS_PROXY 但不想让 mimo2codex 跟着走。
  // 任意非空值生效，与 MIMO2CODEX_VERBOSE 等保持一致。注意：opt-out 只关代理，
  // 仍然装一个带超时的普通 Agent —— 超时修复是全局的，不受代理开关影响。
  const optedOut = !!env.MIMO2CODEX_NO_PROXY_FROM_ENV;

  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  const useProxy = !optedOut && !!(httpProxy || httpsProxy);

  const dispatcher = useProxy
    ? new EnvHttpProxyAgent(agentOpts)
    : new Agent(agentOpts);
  set(dispatcher);

  if (optedOut) {
    return { enabled: false, reason: "opted-out", headersTimeoutMs, bodyTimeoutMs };
  }
  if (!httpProxy && !httpsProxy) {
    return { enabled: false, reason: "no-env", headersTimeoutMs, bodyTimeoutMs };
  }
  return { enabled: true, httpProxy, httpsProxy, noProxy, headersTimeoutMs, bodyTimeoutMs };
}

/** 抹掉代理 URL 里的密码，banner / 日志安全可见。 */
export function redactProxyUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}
