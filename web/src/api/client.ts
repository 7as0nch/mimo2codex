const BASE = "/admin/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // Same-origin cookies (session) flow with /admin/api/* in both prod and the
    // Vite dev proxy (which forwards Set-Cookie + Cookie through to :8788).
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, err?.error?.code, err?.error?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export interface ProviderInfo {
  // Provider id is a runtime-registered string; "mimo" and "deepseek" are
  // built in, anything else is a user-declared generic provider.
  id: string;
  shortcut: string;
  display_name: string;
  default: boolean;
  enabled: boolean;
  api_key_present: boolean;
  api_key_env: string[];
  base_url: string;
  default_model: string;
  flags: Record<string, boolean>;
}

export interface SetupSnippetTarget {
  providerId: string;
  providerKey: string;
  providerLabel: string;
  modelId: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface SetupSnippetBundle {
  target: SetupSnippetTarget;
  authJson: string;
  configToml: string;
  configTomlEnvKey: string;
  ccSwitchAuthJson: string;
  ccSwitchConfigToml: string;
}

export interface SetupSnippetsResponse {
  bundle: SetupSnippetBundle;
  defaultProviderId: string;
  providers: Array<{ id: string; shortcut: string; display_name: string }>;
}

// Generic provider spec — mirror of GenericProviderSpec in src/providers/generic.ts.
// Stored verbatim in providers.json.
export interface GenericProviderModelSpec {
  id: string;
  aliases?: string[];
  displayName?: string;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsWebSearch?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  deprecatedAfter?: string;
}

export interface GenericProviderSpec {
  id: string;
  shortcut?: string;
  displayName?: string;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  wireApi?: "chat" | "responses";
  models?: GenericProviderModelSpec[];
  features?: {
    webSearch?: boolean;
    forceParallelToolCalls?: boolean;
    // minimax-compat: 严格 OpenAI 兼容子开关。命名以 MiniMax 首位受益者命名，
    // 但任何严格的 OpenAI-compat 上游（国产模型网关等）都能复用。
    minimaxCompat?: boolean;
    dropNullStrict?: boolean;
    dropNullContent?: boolean;
    dropToolChoiceAuto?: boolean;
    dropStreamOptions?: boolean;
    dropParallelToolCalls?: boolean;
    mergeSystemMessages?: boolean;
    extractThinkTags?: boolean;
    // SenseNova 6.7 Flash-Lite 等"严格 OpenAI 子集"网关不接受 response_format。
    dropResponseFormat?: boolean;
    // SenseNova 等只接受 tools[].type ∈ {function, custom}；过滤 OpenAI 内置 tool。
    dropNonFunctionTools?: boolean;
    // Kimi 不识别 reasoning_effort，靠 thinking:{enabled/disabled} 控制思考；strip 该字段。
    dropReasoningEffort?: boolean;
    // 选填预设 id，让 generic provider 复用 builtin 的"友好错误翻译"能力。
    enhanceErrorPreset?: "sensenova" | "minimax" | "kimi";
  };
  docsUrl?: string;
  // minimax-compat: 顶层开关。models: [] 时让 resolveModel 返回 null，
  // 未知客户端模型名（如 "gpt-5.5"）会被改写到本 provider 的 defaultModel。
  forceDefaultModel?: boolean;
}

export interface GenericProvidersResponse {
  specs: GenericProviderSpec[];
  path: string | null;
  source: "explicit" | "default" | null;
  exists: boolean;
  editable: boolean;
  notice?: string;
  error?: string;
}

// 已知厂商预设元数据。镜像 src/providers/presets.ts 的 ProviderPreset 结构。
// admin UI 用 matchBaseUrl / matchModelPrefix 判断用户在编辑 generic provider 时
// 是否命中已知厂商，命中则自动套用 recommendedSpec.features。
export interface ProviderPresetClient {
  id: "minimax" | "sensenova" | "kimi";
  displayName: string;
  matchBaseUrl: string[];
  matchModelPrefix: string[];
  recommendedSpec: {
    baseUrl: string;
    defaultModel: string;
    docsUrl: string;
    features: Record<string, boolean | string>;
  };
}

export interface ProviderPresetsResponse {
  presets: ProviderPresetClient[];
}

export interface ModelRow {
  id: number;
  provider_id: string;
  upstream_id: string;
  display_name: string | null;
  supports_images: number;
  supports_reasoning: number;
  supports_web_search: number;
  context_window: number | null;
  is_builtin: number;
  deprecated_after: string | null;
  sort_order: number;
}

export interface LogRow {
  id: number;
  ts: number;
  request_id: string | null;
  provider_id: string;
  client_model: string;
  upstream_model: string;
  endpoint: string;
  status_code: number;
  duration_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  stream: number;
  error_code: string | null;
  error_snippet: string | null;
  tool_call_count: number | null;
  cached_tokens: number | null;
}

export interface LogDetail extends LogRow {
  request_body: string | null;
  response_body: string | null;
}

export type LogBodyMode = "full" | "errors-only" | "off";

export interface LogSettingsResponse {
  silentRewrite: boolean;
  cliOverride: boolean | null;
  bodyMode: LogBodyMode;
  bodyModeCliOverride: LogBodyMode | null;
  retentionDays: number | null;
  retentionDaysCliOverride: number | null;
  retentionDaysCliOverrideActive: boolean;
}

export interface MappingRow {
  provider_id: string;
  client_model: string;
  upstream_model: string;
  count: number;
  last_seen: number;
}

export interface StatsResponse {
  since: number;
  rows: Array<{
    provider_id: string;
    upstream_model: string;
    requests: number;
    errors: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }>;
}

export interface TokenTimeseriesSeries {
  provider_id: string;
  upstream_model: string;
  tokens: number[];
  prompt_tokens: number[];
  completion_tokens: number[];
  // Upstream-reported prompt-cache hits per bucket. Zero-filled when the
  // upstream returned no cache info (pre-v3 rows / providers without caching).
  cached_tokens: number[];
  total: number;
}

export type TimeseriesBucket = "day" | "hour";

export interface TokenTimeseriesResponse {
  range: string;
  bucket: TimeseriesBucket;
  since: number;
  buckets: string[];
  series: TokenTimeseriesSeries[];
}

export interface ErrorStatsResponse {
  since: number;
  rows: Array<{ error_code: string; count: number }>;
}

export interface LatencyStatsResponse {
  since: number;
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface ProviderHealthRow {
  provider_id: string;
  requests: number;
  errors: number;
  error_rate: number;
  last_seen: number | null;
}

// ───────── Codex 启用 ─────────

export interface CodexTarget {
  providerId: string;
  providerDisplayName: string;
  providerKey: string;
  modelId: string;
  displayName: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  source: "builtin" | "custom";
  hasKey: boolean;
  isCurrentOverride: boolean;
}

export interface ActiveOverride {
  providerId: string;
  modelId: string;
}

export interface CodexBackupPair {
  ts: number;
  authBackup: string | null;
  tomlBackup: string | null;
  // True when this backup captured an external auth.json (real OpenAI key
  // or another tool's writes). Preserved backups are exempt from automatic
  // pruning and require force=true to delete.
  preserved: boolean;
  // Sniffed from the backed-up config.toml — surfaces "this snapshot used
  // provider=X / model=Y" so the user can tell different snapshots apart.
  model: string | null;
  provider: string | null;
  // Owner inferred from the backed-up auth.json content.
  authBackupOwner: "mimo2codex" | "external" | "missing";
}

export interface CodexState {
  codexDir: string;
  authPath: string;
  tomlPath: string;
  authJsonOwner: "mimo2codex" | "external" | "missing";
  authJsonExists: boolean;
  configTomlExists: boolean;
  configTomlText: string | null;
  backups: CodexBackupPair[];
  activeOverride: ActiveOverride | null;
}

export interface CodexTargetsResponse {
  targets: CodexTarget[];
  activeOverride: ActiveOverride | null;
  authJsonOwner: "mimo2codex" | "external" | "missing";
}

export interface CodexApplyResponse {
  ok: boolean;
  backupTs: number | null;
  authBackup: string | null;
  tomlBackup: string | null;
  authJsonOwnerBefore: "mimo2codex" | "external" | "missing";
  preserved?: boolean;
  restartRequired: boolean;
  historyId?: number;
  bundleUrl?: string | null;
}

export interface CodexSession {
  id: string;
  provider: string;
  cwd: string;
  title: string;
  firstUserMessage: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  rolloutPath: string;
  tokensUsed: number;
}

export interface CodexSessionsResponse {
  localOnly: boolean;
  dbPath: string | null;
  available: boolean;
  sessions: CodexSession[];
  providers: string[];
}

export interface TranscriptItem {
  kind: "message" | "reasoning" | "tool";
  // message
  role?: "user" | "assistant";
  text?: string;
  context?: boolean;
  // tool
  name?: string;
  command?: string | null;
  input?: string | null;
  output?: string;
  status?: string | null;
}

export interface SessionTranscript {
  localOnly: boolean;
  available: boolean;
  title?: string;
  cwd: string | null;
  model: string | null;
  items: TranscriptItem[];
}

export interface CodexMigrateResponse {
  ok: boolean;
  restartRequired: boolean;
  id: string;
  fromProvider: string;
  toProvider: string;
  backupDir: string;
}

export interface CodexHistoryRow {
  id: number;
  ts: number;
  kind: "initial" | "apply" | "restore";
  provider_id: string | null;
  model_id: string | null;
  note: string | null;
}

export interface CodexBundleResponse {
  history: CodexHistoryRow;
  files: { authJson: string; configToml: string };
  scripts: { posix: string; powershell: string };
  // Present (non-null) when the server auto-minted a fresh m2c API key for
  // this download and embedded it into auth.json. Null in local mode and on
  // 'initial' snapshot bundles.
  mintedKey: { name: string; prefix: string } | null;
}

export interface AuthUser {
  id: number;
  username: string;
  display_name: string | null;
  is_admin: boolean;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface AuthMeResponse {
  authMode: "off" | "on";
  user: AuthUser | null;
  needsBootstrap: boolean;
  allowRegister: boolean;
}

export interface UserWithUsage extends AuthUser {
  request_count: number;
  total_tokens: number;
  last_activity: number | null;
}

export interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface UpstreamKeySummary {
  provider_id: string;
  created_at: number;
  updated_at: number;
}

export interface BuiltinPluginInfo {
  id: string;
  name: string;
  description: string;
  category: "computer-use";
  mcpServerName: string;
  pluginRoot: string;
  serverPath: string;
  docsPath: string;
  builtin: boolean;
  installed: boolean;
  enabled: boolean;
  settingEnabled: boolean;
  envOverride: boolean | null;
  locked: boolean;
  configEnabled: boolean;
  configPath: string;
  envKey: string;
  settingKey: string;
  hotReload: boolean;
  codexRestartRecommended: boolean;
  quickstartMarkdown: string | null;
}

export interface PluginSetResponse {
  ok: boolean;
  apply: {
    ok: true;
    path: string;
    enabled: boolean;
    backupPath: string | null;
    changed: boolean;
  };
  plugin: BuiltinPluginInfo;
}

export interface AdapterInstallPlan {
  ok?: boolean;
  autoInstall?: boolean;
  prerequisites?: string[];
  steps?: string[];
  message?: string;
  docs?: string;
  repo?: string;
}

export interface AdapterStatus {
  adapterOk: boolean;
  backend: string | null;
  command: string[] | null;
  message: string | null;
  code: string | null;
  installPlan: AdapterInstallPlan | null;
  error?: string;
}

export interface AdapterStreamHandlers {
  onStart?: () => void;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  onDone?: (data: { ok: boolean; exitCode: number | null; configChanged?: boolean }) => void;
  onError?: (message: string) => void;
}

// POST an adapter install/uninstall and consume the server's SSE stream. We use
// fetch (not EventSource) so the request can be a POST carrying the admin
// session cookie. Resolves when the stream ends; throws ApiError on a non-2xx.
export async function streamPluginAdapterAction(
  id: string,
  action: "install" | "uninstall",
  handlers: AdapterStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(
    `${BASE}/plugins/${encodeURIComponent(id)}/adapter/${action}`,
    { method: "POST", credentials: "same-origin", headers: { Accept: "text/event-stream" }, signal }
  );
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text() : "";
    let code: string | undefined;
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = j?.error?.code;
      message = j?.error?.message ?? message;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, code, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let dataStr = "";
      for (const ln of frame.split("\n")) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
      }
      let data: unknown = null;
      try {
        data = dataStr ? JSON.parse(dataStr) : null;
      } catch {
        data = dataStr;
      }
      const d = (data ?? {}) as Record<string, unknown>;
      if (event === "start") handlers.onStart?.();
      else if (event === "log")
        handlers.onLog?.(String(d.line ?? ""), (d.stream as "stdout" | "stderr") ?? "stdout");
      else if (event === "done")
        handlers.onDone?.(d as { ok: boolean; exitCode: number | null; configChanged?: boolean });
      else if (event === "error") handlers.onError?.(String(d.message ?? "error"));
    }
  }
}

export const api = {
  health: () => request<HealthResponse>("GET", "/health"),
  authMe: () => request<AuthMeResponse>("GET", "/auth/me"),
  login: (body: { username: string; password: string }) =>
    request<{ user: AuthUser }>("POST", "/auth/login", body),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),
  bootstrap: (body: { username: string; password: string; displayName?: string }) =>
    request<{ user: AuthUser }>("POST", "/bootstrap", body),
  register: (body: { username: string; password: string; displayName?: string }) =>
    request<{ user: AuthUser }>("POST", "/auth/register", body),
  getRegisterPolicy: () =>
    request<{ allowRegister: boolean }>("GET", "/auth/register-policy"),
  setRegisterPolicy: (allowRegister: boolean) =>
    request<{ allowRegister: boolean }>("PUT", "/auth/register-policy", { allowRegister }),
  listUsers: () => request<{ users: UserWithUsage[] }>("GET", "/users"),
  createUserAdmin: (body: { username: string; password: string; displayName?: string; isAdmin?: boolean }) =>
    request<{ user: AuthUser }>("POST", "/users", body),
  patchUser: (
    id: number,
    body: Partial<{
      displayName: string | null;
      isAdmin: boolean;
      status: "active" | "disabled";
      password: string;
    }>
  ) => request<{ user: AuthUser }>("PATCH", `/users/${id}`, body),
  meApiKeys: () =>
    request<{ api_keys: ApiKeyRow[] }>("GET", "/me/api-keys"),
  meCreateApiKey: (name: string) =>
    request<{ token: string; api_key: ApiKeyRow }>("POST", "/me/api-keys", { name }),
  meRevokeApiKey: (id: number) =>
    request<{ revoked: boolean }>("DELETE", `/me/api-keys/${id}`),
  meUpstreamKeys: () =>
    request<{ upstream_keys: UpstreamKeySummary[] }>("GET", "/me/upstream-keys"),
  meSetUpstreamKey: (providerId: string, apiKey: string) =>
    request<{ ok: boolean; provider_id: string }>(
      "PUT",
      `/me/upstream-keys/${encodeURIComponent(providerId)}`,
      { apiKey }
    ),
  meDeleteUpstreamKey: (providerId: string) =>
    request<{ deleted: boolean }>(
      "DELETE",
      `/me/upstream-keys/${encodeURIComponent(providerId)}`
    ),
  codexHistory: () =>
    request<{ history: CodexHistoryRow[] }>("GET", "/codex-history"),
  codexHistoryBundle: (id: number) =>
    request<CodexBundleResponse>("GET", `/codex-history/${id}/bundle`),
  codexHistoryDelete: (id: number) =>
    request<{ deleted: boolean }>("DELETE", `/codex-history/${id}`),
  codexCurrentBundle: () =>
    request<CodexBundleResponse>("GET", "/codex-current-bundle"),
  codexImport: (body: {
    authJson: string;
    configToml: string;
    providerId?: string;
    modelId?: string;
    note?: string;
  }) =>
    request<{ ok: boolean; historyId: number; restartRequired: boolean; bundleUrl: string | null }>(
      "POST",
      "/codex-import",
      body
    ),
  oauthPublicProviders: () =>
    request<{ providers: Array<{ provider: "github" | "gitee"; callback_url: string }> }>(
      "GET",
      "/auth/oauth-providers"
    ),
  oauthClients: () =>
    request<{
      clients: Array<{
        provider: "github" | "gitee";
        client_id: string;
        callback_url: string;
        enabled: boolean;
        updated_at: number;
        has_secret: boolean;
      }>;
    }>("GET", "/oauth-clients"),
  saveOAuthClient: (
    provider: "github" | "gitee",
    body: { clientId: string; clientSecret: string | null; callbackUrl: string; enabled: boolean }
  ) => request<{ ok: boolean }>("PUT", `/oauth-clients/${provider}`, body),
  deleteOAuthClient: (provider: "github" | "gitee") =>
    request<{ deleted: boolean }>("DELETE", `/oauth-clients/${provider}`),
  providers: () => request<{ providers: ProviderInfo[] }>("GET", "/providers"),
  modelsFor: (providerId: string) =>
    request<{ models: ModelRow[] }>("GET", `/providers/${providerId}/models`),
  createModel: (providerId: string, body: { upstream_id: string; display_name?: string }) =>
    request<{ model: ModelRow }>("POST", `/providers/${providerId}/models`, body),
  patchModel: (id: number, body: Partial<ModelRow>) =>
    request<{ model: ModelRow }>("PATCH", `/models/${id}`, body),
  deleteModel: (id: number) => request<{ deleted: boolean }>("DELETE", `/models/${id}`),
  logs: (
    params: {
      provider?: string;
      model?: string;
      statusMin?: number;
      statusMax?: number;
      limit?: number;
      offset?: number;
    } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.provider) qs.set("provider", params.provider);
    if (params.model) qs.set("model", params.model);
    if (typeof params.statusMin === "number") qs.set("statusMin", String(params.statusMin));
    if (typeof params.statusMax === "number") qs.set("statusMax", String(params.statusMax));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ logs: LogRow[] }>("GET", `/logs${suffix}`);
  },
  logDetail: (id: number) => request<{ log: LogDetail }>("GET", `/logs/${id}`),
  deleteLogsBefore: (ts: number) =>
    request<{ removed: number }>("DELETE", `/logs?before=${ts}`),
  mappings: () => request<{ mappings: MappingRow[] }>("GET", "/mappings"),
  stats: (range: "24h" | "7d" | "30d" = "24h") =>
    request<StatsResponse>("GET", `/stats?range=${range}`),
  tokenTimeseries: (range: "24h" | "7d" | "30d" = "7d", bucket: TimeseriesBucket = "day") =>
    request<TokenTimeseriesResponse>(
      "GET",
      `/stats/timeseries?range=${range}&bucket=${bucket}`
    ),
  errorStats: (range: "24h" | "7d" | "30d" = "24h") =>
    request<ErrorStatsResponse>("GET", `/stats/errors?range=${range}`),
  latencyStats: (range: "24h" | "7d" | "30d" = "24h") =>
    request<LatencyStatsResponse>("GET", `/stats/latency?range=${range}`),
  providerHealth: () =>
    request<{ rows: ProviderHealthRow[] }>("GET", "/provider-health"),
  plugins: () => request<{ plugins: BuiltinPluginInfo[] }>("GET", "/plugins"),
  plugin: (id: string) =>
    request<{ plugin: BuiltinPluginInfo }>("GET", `/plugins/${encodeURIComponent(id)}`),
  setPluginEnabled: (id: string, enabled: boolean) =>
    request<PluginSetResponse>("PUT", `/plugins/${encodeURIComponent(id)}`, { enabled }),
  pluginAdapter: (id: string) =>
    request<{ adapter: AdapterStatus }>("GET", `/plugins/${encodeURIComponent(id)}/adapter`),
  settings: () => request<{ settings: Record<string, string> }>("GET", "/settings"),
  setSetting: (key: string, value: string) =>
    request<{ key: string; value: string }>("PUT", `/settings/${encodeURIComponent(key)}`, {
      value,
    }),
  setupSnippets: (providerId?: string) => {
    const qs = providerId ? `?provider=${encodeURIComponent(providerId)}` : "";
    return request<SetupSnippetsResponse>("GET", `/setup-snippets${qs}`);
  },
  genericProviders: () =>
    request<GenericProvidersResponse>("GET", "/generic-providers"),
  saveGenericProviders: (providers: GenericProviderSpec[]) =>
    request<{ ok: boolean; path: string; restartRequired: boolean }>(
      "PUT",
      "/generic-providers",
      { providers }
    ),
  providerPresets: () =>
    request<ProviderPresetsResponse>("GET", "/provider-presets"),
  thinkingState: () =>
    request<{
      effective: boolean;
      cliOverride: boolean | null;
      setting: boolean;
      forceHighEffort: boolean;
    }>("GET", "/thinking-state"),
  setThinkingDisabled: (disabled: boolean) =>
    request<{ ok: boolean }>("PUT", "/thinking-state", { disabled }),
  setForceHighEffort: (forceHighEffort: boolean) =>
    request<{ ok: boolean }>("PUT", "/thinking-state", { forceHighEffort }),
  visionFallback: () =>
    request<{ enabled: boolean; model: string }>("GET", "/vision-fallback"),
  setVisionFallback: (body: { enabled?: boolean; model?: string }) =>
    request<{ ok: boolean }>("PUT", "/vision-fallback", body),
  logSettings: () => request<LogSettingsResponse>("GET", "/log-settings"),
  setSilentRewrite: (silentRewrite: boolean) =>
    request<{ ok: boolean }>("PUT", "/log-settings", { silentRewrite }),
  setLogSettings: (body: { bodyMode?: LogBodyMode; retentionDays?: number | null }) =>
    request<{ ok: boolean }>("PUT", "/log-settings", body),
  codexState: () => request<CodexState>("GET", "/codex-state"),
  codexTargets: () => request<CodexTargetsResponse>("GET", "/codex-targets"),
  codexApply: (body: { providerId: string; modelId: string }) =>
    request<CodexApplyResponse>("POST", "/codex-apply", body),
  codexRestore: (ts: number) =>
    request<{ ok: boolean; restartRequired: boolean }>("POST", "/codex-restore", { ts }),
  codexSessions: () => request<CodexSessionsResponse>("GET", "/codex-sessions"),
  codexMigrateSession: (body: { id: string; toProvider: string }) =>
    request<CodexMigrateResponse>("POST", "/codex-sessions/migrate", body),
  codexSessionTranscript: (id: string) =>
    request<SessionTranscript>(
      "GET",
      `/codex-sessions/transcript?id=${encodeURIComponent(id)}`
    ),
  codexRestart: () =>
    request<{
      ok: boolean;
      supported: boolean;
      platform: string;
      wasRunning: boolean;
      killed: number;
      relaunched: boolean;
    }>("POST", "/codex-restart"),
  deleteCodexBackup: (ts: number, force = false) =>
    request<{ ok: boolean; removed: number }>(
      "DELETE",
      `/codex-backups/${ts}${force ? "?force=1" : ""}`
    ),
  getActiveOverride: () =>
    request<{ override: ActiveOverride | null }>("GET", "/active-override"),
  setActiveOverride: (body: { providerId: string; modelId: string }) =>
    request<{ override: ActiveOverride }>("PUT", "/active-override", body),
  clearActiveOverride: () =>
    request<{ deleted: boolean }>("DELETE", "/active-override"),
  probeModel: (body: { providerId: string; modelId: string }) =>
    request<ProbeResult>("POST", "/probe-model", body),
  codexDir: () => request<CodexDirInfo>("GET", "/codex-dir"),
  setCodexDir: (dir: string) =>
    request<CodexDirInfo>("PUT", "/codex-dir", { dir }),
  clearCodexDir: () => request<CodexDirInfo>("DELETE", "/codex-dir"),
  updateStatus: () => request<UpdateStatusResponse>("GET", "/update-status"),
  checkUpdate: () => request<UpdateStatusResponse>("POST", "/check-update"),
  updatePreference: (body: { updateCheckDisabled?: boolean; ignoredVersion?: string | null }) =>
    request<UpdateStatusResponse>("POST", "/update-preference", body),
  // SSE-based update endpoint — returns the URL so callers can use EventSource
  // directly (the shared `request` wrapper is JSON-only).
  updateStreamUrl: () => `${BASE}/update`,
  // ── Data directory management ────────────────────────────────────────────
  dataDirInfo: () => request<DataDirInfo>("GET", "/data-dir/info"),
  dataDirPreview: (targetDir: string) =>
    request<DataDirPreview>("POST", "/data-dir/preview", { targetDir }),
  dataDirMigrateStreamUrl: () => `${BASE}/data-dir/migrate`,
  // ── Desktop shell integration (v0.5.6) ───────────────────────────────────
  // Tell the admin UI whether it's running inside the Electron desktop app.
  // Returns inDesktop=true only when the sidecar was spawned by the desktop
  // (MIMO2CODEX_DESKTOP_PARENT=1 env var). UI uses this to decide whether to
  // expose the "Open Desktop Settings" button.
  desktopSentinel: () =>
    request<{ inDesktop: boolean }>("GET", "/desktop/sentinel"),
  // Signal the Electron main process via a file watcher (see
  // package/desktop/src/signalWatcher.ts). action="open-settings" pops the
  // Settings window. Only succeeds when inDesktop=true.
  desktopSignal: (action: "open-settings") =>
    request<{ ok: boolean }>("POST", "/desktop/signal", { action }),
};

// /admin/api/health extended response. Existing fields stay; `maintenance` and
// `restartRequired` are new — falsy in normal operation, flipped by the data-
// directory migration flow.
export interface HealthResponse {
  ok: boolean;
  dataDir: string;
  version: string;
  authMode: "off" | "on";
  maintenance?: boolean;
  restartRequired?: boolean;
  restartReason?: string | null;
  restartTargetDir?: string | null;
}

export interface DataDirInfo {
  current: string;
  source: "cli" | "env" | "pointer" | "default";
  defaultDir: string;
  envOverride: string | null;
  pointerValue: string | null;
  pointerPath: string;
  editable: boolean;
}

export interface DataDirPreview {
  ok: boolean;
  resolved: string;
  fileCount: number;
  totalBytes: number;
  sameVolumeHint: boolean;
  targetExists: boolean;
  targetEmpty: boolean;
  warnings: string[];
  errors: string[];
}

export type MigrationStreamEntry =
  | { type: "start"; ts: number; srcDir: string; destDir: string }
  | { type: "scan"; fileCount: number; totalBytes: number }
  | {
      type: "progress";
      copiedFiles: number;
      copiedBytes: number;
      totalFiles: number;
      totalBytes: number;
      currentFile: string;
    }
  | { type: "pointer"; path: string }
  | { type: "done"; ts: number; destDir: string }
  | { type: "error"; code: string; message: string };

// /admin/api/update-status response. Backend computes `hasUpdate` after
// comparing cached `latest` against the current version, and surfaces the
// detected install method so the UI can pick the right copy-paste command.
export interface UpdateStatusResponse {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  channel: "latest" | "beta";
  checkedAt: number | null;
  source: "cache" | "fresh" | "skipped";
  method: "npm-global" | "git" | "desktop" | "unknown";
  command: string;
  rootDir: string;
  preferences: {
    updateCheckDisabled: boolean;
    ignoredVersion: string | null;
    // True iff the user has already pressed "ignore this version" for the
    // currently-advertised version — UI hides the banner without forgetting
    // about future newer versions.
    effectivelyDismissed: boolean;
  };
}

// /admin/api/codex-dir response. `source` tells the UI which layer of the
// resolution chain produced `effective`, so it can show "default" / env /
// user-set without recomputing on the client.
export interface CodexDirInfo {
  effective: string;
  override: string | null;
  envOverride?: string | null;
  source: "user" | "env" | "default";
}

// Result of a /probe-model call. ok=false rows still come back as 200 from
// the server (with the failure details in `error`) — only schema-level errors
// (unknown provider, malformed body) come back as non-200 throws.
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  upstreamPath?: string;
  sample?: string | null;
  error?: { code: string; message: string };
}
