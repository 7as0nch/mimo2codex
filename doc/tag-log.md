# Tag Log

<p>
  <a href="./tag-log.md"><strong>English</strong></a> ·
  <a href="./tag-log.zh.md">简体中文</a>
</p>

Release history of mimo2codex, newest first.

**Category tags**

- **[new]** / **[feat]**: new features
- **[fix]**: bug fixes
- **[opt]** / **[refactor]**: optimization / refactor
- **[doc]**: documentation
- **[test]**: tests

---

## v0.5.23 (upcoming)

- **[new]** **Windows: isolated Codex CLI launcher** (PR #64, thanks @Kaiyuan GONG): a new `scripts/codex-mimo-isolated.ps1` lets you run **Codex CLI** against MiMo via mimo2codex **without touching the `~/.codex` used by Codex Desktop**. It uses a separate `CODEX_HOME=%USERPROFILE%\.codex-mimo`, writes a minimal `auth.json` + `config.toml` there on first run, auto-starts the proxy if `:8788` isn't already listening, prints the local API/admin URLs, then forwards all remaining args to `codex`. API keys are not hardcoded — configure them via `mimo2codex init`. See `doc/codex-cli-isolated-windows.zh.md` for the walkthrough.

- **[fix]** **Saving a generic provider with a duplicate shortcut no longer bricks the admin UI (`/admin/` 404)** (issue #63): `providers.shortcut` is `UNIQUE`, but the save path only de-duped provider `id`, not `shortcut`. A generic whose shortcut collided with a built-in (`mimo` / `ds`) or with another generic would save fine, then crash the **next** startup's DB seed (`UNIQUE constraint failed: providers.shortcut`), which the cli.ts fallback then turned into a disabled admin — so every `/admin/` request 404'd. Two-layer fix: (1) `writeSpecsToFile` now rejects a colliding shortcut **at save time** with a clear message (seeded with the built-in shortcuts); (2) DB seeding de-dupes by shortcut (`dedupeProvidersByShortcut`) — a duplicate is **skipped with a warning** instead of crashing the whole seed, so anyone who already saved a dirty `providers.json` gets their admin back on the next start.

- **[fix]** **`enhanceErrorPreset: "kimi"` is no longer silently dropped from generic providers**: `kimi` is a valid `ProviderPresetId` (`src/providers/presets.ts`) but the providers.json parser only accepted `sensenova` / `minimax`, so a Kimi error-diagnostic preset never persisted. It's now accepted alongside the others.

---

## v0.5.22

- **[new]** **Multimodal fallback — auto-switch to a vision model when a request carries images** (PR #58, thanks @Grub): when a request contains images but the active model can't see them (e.g. `mimo-v2.5-pro`), the proxy rewrites the upstream model to a vision-capable one (default `mimo-v2.5`) so the image is processed instead of silently dropped — applied on both the Responses and Chat paths. **Scoped to MiMo — other providers are never affected**: vision capability is a MiMo provider feature (`provider.supportsVision`), so only MiMo triggers the fallback; DeepSeek / generic requests are left untouched. Even on MiMo, the switch is skipped when the fallback model can't be resolved. Toggle + target model live in the admin UI → Codex Integration → "Multimodal fallback" card; **disabled by default** — enable it when your workflow mixes vision and non-vision models.

---

## v0.5.21

- **[fix]** **Sustained 429 rate limits no longer break the session (follow-up to v0.5.20's retry)**: v0.5.20 added proxy-side 429/5xx retry, but the default budget (3 retries, ~3.5s) only outlasted sub-second blips. Real per-minute quota limits (`429 Too many requests / limitation`, often *without* a `Retry-After` header) still exhausted it, so the raw 429 was forwarded to Codex, which then burned its own retries and surfaced "exceeded retry limit, last status: 429" again. The default retry budget is now larger: **6 retries with exponential backoff capped at 12s (~28s total)**, so a multi-second quota limit clears before we give up. Still abortable, still honors `Retry-After` when present, and still tunable via `MIMO2CODEX_UPSTREAM_MAX_RETRIES` (now up to 12) / `MIMO2CODEX_UPSTREAM_RETRY_BASE_MS`. Trade-off: while rate-limited, a single request now waits up to ~28s before failing instead of ~3.5s.

- **[new]** **Log storage controls for long-running deployments**: **what problem this solves** — every request/response used to be logged in full and kept forever, so on always-on installs (Docker, shared/team setups) `data.db` grows without bound: it eats disk, slows backups and the Logs page, and keeps full conversation text around far longer than you may want for privacy. Two knobs now cap that. `MIMO2CODEX_LOG_BODY_MODE=full|errors-only|off` (also in the Logs page → "Storage settings") keeps full debugging detail, stores bodies for failed requests only (enough to triage, far smaller), or disables body capture entirely. `MIMO2CODEX_LOG_RETENTION_DAYS=<n>` (same place) auto-deletes rows older than `n` days — on startup and every 6h while running; `0` disables pruning. Typical use: a small VPS / team proxy sets `errors-only` + `30` so the DB stays bounded instead of ballooning over months. Settings live in the DB (no restart) and the env/CLI value wins when set.

---

## v0.5.20

- **[fix]** **Transient upstream 429 / 5xx no longer break the session ("exceeded retry limit, last status: 429")**: the proxy used to forward a rate-limit straight back to Codex, which then burned its own `request_max_retries` and gave up — leaving the user to manually hit "continue". mimo2codex now absorbs transient failures itself: `postUpstream` retries `429` and `500/502/503/504` (and network connect failures) with exponential backoff + jitter, honoring the upstream's `Retry-After` header (capped at 10s so Codex doesn't time out). Retries are abortable — a Codex cancel during backoff stops immediately. Non-retryable errors (400/401/403 …) still fail fast. Tunable via `MIMO2CODEX_UPSTREAM_MAX_RETRIES` (default 3) and `MIMO2CODEX_UPSTREAM_RETRY_BASE_MS` (default 500).

- **[fix]** **"写入文件并启用" no longer wipes your other config.toml settings**: applying a model used to overwrite the whole `~/.codex/config.toml` with just `model` + `model_provider` + `[model_providers.<key>]`, silently dropping everything else the user had — `[projects]` trust levels, `[mcp_servers]`, `[windows] sandbox`, `model_reasoning_effort`, `[notice.model_migrations]`, comments. Switching models now does a **surgical merge** (`src/codex/tomlMerge.ts`): only the four keys we manage (`model`, `model_provider`, `model_context_window`, `model_max_output_tokens`) and our own `[model_providers.<key>]` table are rewritten; every other byte is preserved. A fresh install (no existing config.toml) still gets the rich first-run snippet. Backups are still taken before every write, so any prior config remains fully restorable.
- **[new]** **Session Manager — browse all Codex sessions across providers and migrate them** (new left-nav tab). Codex Desktop stores each session in `~/.codex/state_<N>.sqlite` (`threads` table) tagged with one `model_provider`, and filters its session list by it — which is why switching providers in mimo2codex made "ds and mimo sessions invisible to each other". The new tab reads that DB (read-only) and shows every session grouped by **provider → project (cwd) → session**, regardless of which provider is currently active. Display niceties: the Windows extended-length `\\?\` prefix is stripped from project paths (so the same project doesn't split into two groups), session timestamps render correctly (Codex stores seconds), long titles are middle-ellipsized to one line, and only the first provider group is expanded by default. Since a session can't be *shared* across providers (the row holds exactly one), it can be **migrated**: "Migrate to…" rewrites the session's `model_provider` (in the DB and the rollout file's `session_meta`) so Codex lists it under the chosen provider after a restart. **Batch migrate**: tick the checkboxes (selection spans every project/provider table) and "Migrate selected" moves them all to one provider in one go. Safety: mimo2codex snapshots the whole state DB (+ `-wal`/`-shm`) and the rollout into `~/.codex/.m2c-backups/sessions/<ts>/` before touching anything, and **refuses to migrate while Codex Desktop holds the DB lock** (a `409 codex_running`) so an open app can't corrupt its sessions. Local mode only. ⚠️ This edits Codex's private, version-stamped state — if a future Codex changes the schema, the tab degrades to "unavailable" rather than breaking.
- **[new]** **Preview a session's chat transcript + export to Markdown**: each session row has a "Preview" button that opens a drawer rendering the conversation Codex-style — user/assistant messages, reasoning, and tool calls (shell commands, `apply_patch` …) with their output in code blocks. Tool/shell calls are **collapsed by default** (header shows the tool + first command line) so the text conversation stands out — click to expand. The rollout JSONL is parsed server-side (`src/codex/transcript.ts`); injected developer/permission blocks are dropped and environment/instruction context is collapsed so the real conversation stands out. An "Export Markdown" button downloads the whole transcript as a `.md` file. Read-only, local mode only.
- **[new]** **Live "当前状态" Codex indicator in the header**: the current state is something users check constantly, so it now sits in the top bar alongside the other status items, instead of taking up a card on the Codex page. It's a compact ticker labeled "当前状态" that cycles every 3s through each state row — codex dir, auth.json owner, config.toml provider/model, runtime override — and turns blue when a runtime override is active. Clicking it opens the full state (codex dir + editor, auth.json, config.toml, override, export/import) — a popover on wide screens, a modal when narrow. Auto-refreshes every 30s.
- **[opt]** **Codex page slimmed to direct model switching**: the "current state" card moved to the header (above) and the redundant quick-switch bar was dropped, so the Codex Integration page is now just the title + the model-switch table ("可启用模型" / "写入文件并启用"). The two "工作原理" mode explanations and the intro were already folded into the collapsible "先决条件" panel (default-collapsed).
- **[new]** **Restart Codex right after applying a config**: a config switch only takes effect once Codex reloads, so applying one ("写入文件并启用") now pops a "Restart Codex to apply the change?" dialog (Restart now / Not now). It force-closes the running Codex Desktop app and relaunches it (and just launches it if it wasn't running), so you don't have to hunt for the app to close it yourself. Windows: targets only the Desktop app's own `Codex.exe` processes (matched by executable path, so the VS Code extension's `codex` engine is left alone) and relaunches via the Store AppUserModelID. macOS: best-effort `pkill` + `open -a Codex`. Local mode only; unsupported platforms tell you to restart manually.
- **[new]** **Desktop: offer to open Codex on launch**: when you start the mimo2codex desktop app and Codex Desktop isn't already running, a dialog asks whether to open it ("打开 Codex" / "暂不") and launches it for you if you confirm. Detection targets only the real Codex Desktop processes (by executable path); launch goes through the Store AppUserModelID on Windows / `open -a Codex` on macOS. Skipped when Codex is already running, on first-run setup, and on autostart-at-boot launches (so it never nags during boot). Detection + launch reuse the same primitives as the in-app restart.
- **[opt]** **Desktop: double-click the tray icon to open the admin console**: previously double-clicking the system-tray icon did nothing (only right-click opened the menu). It now opens the admin console in-app directly — one gesture instead of right-click → menu. Menu access stays on right-click. (The quit confirmation already lists "Quit" left of "Cancel" with Cancel as the safe default, so that was already as requested.)
- **[opt]** **Config backups moved into a dedicated `~/.codex/.m2c-backups/` folder**: the per-switch `auth.json.bak.*` / `config.toml.bak.*` snapshots used to pile up directly in `~/.codex/`, cluttering the directory listing the Codex app and CLI also read. They now live in a hidden `.m2c-backups/` subfolder (still inside the codex dir, so restore works unchanged). Existing legacy sibling backups are migrated automatically on first read.
- **[opt]** **Model-rewrite log: now silent by default + a quick toggle in the header** (builds on [PR #49](https://github.com/7as0nch/mimo2codex/pull/49), thanks @oxsean). When Codex sends a model id that differs from the provider's catalog (e.g. `gpt-5.4` → `mimo-v2.5-pro`), the proxy logged a "model fallback applied" INFO line on every request. That log is now **suppressed by default**, with a quick switch under the admin header's "更多" menu ("静默模型改写日志") to flip it at runtime — no restart. Resolution order is env > admin setting > silent: `MIMO2CODEX_SILENT_REWRITE=1`/`true` (or `0`/`false`) still wins and, when set, disables the UI toggle.

---

## v0.5.6

- **[fix]** **Long-conversation 400 "unexpected end of data: line 1 column 46 (char 45)"**: once an upstream stream finished mid tool-call (length limit, network cut, client cancel, thinking-budget exhaustion …), Codex persisted the **truncated `tool_call.arguments`** as part of the session history. From that point on, every subsequent request in the same session carried the malformed JSON-as-string field, and strict upstreams (MiMo / DeepSeek / SenseNova …) rejected the request body with a JSON parser error pointing at the truncation point — the session looked permanently broken until the user started a new chat. mimo2codex now sanitizes tool-call arguments at **three layers**: (1) on the way *back* to Codex during streaming (`streamToSse.finalizeToolCalls`) — invalid JSON is salvaged to `"{}"` with a clear WARN that names the cause (length truncation vs. other), so the bad value never reaches Codex's history in the first place; (2) the same defense on the non-streaming path (`respToResponses`); (3) on the way *out* to the upstream (`reqToChat`'s `function_call` branch) — historical `arguments` that failed validation are likewise rewritten to `"{}"`, which immediately revives sessions poisoned by older proxy versions. The matching `tool` message stays paired with the assistant turn (the `removeOrphanToolMessages` / `ensureToolCallsHaveOutputs` invariant is preserved). For the rare case the upstream still returns this shape, `contextOverflow.detectMalformedJsonField` rewrites the raw 400 into a bilingual recovery hint ("upgrade or start a new codex session") instead of dumping the cryptic upstream error at the user.
- **[opt]** **Desktop Settings supports multiple provider keys at once + custom base URLs** ([PR #43](https://github.com/7as0nch/mimo2codex/pull/43) — A1, thanks @starlsd93-sudo). The original Settings window only let you configure one provider's API key at a time, so users running multiple providers (MiMo + DeepSeek) had to switch the provider dropdown and re-save once per key. The new layout shows API key + optional base URL fields for every provider (MiMo, DeepSeek, Generic) on a single page, with `GENERIC_DEFAULT_MODEL` exposed as well. Setup completes if at least one provider has a key; the base URL placeholders show the built-in defaults so users only fill what they want to override (MiMo TP subscription host, DeepSeek tenant, etc.). The MiMo Base URL field includes an inline hint that explains the proxy auto-routes based on the key's `sk-*` / `tp-*` prefix, so new users don't paste the wrong host and get 401. How to open: tray icon → Settings…, or top menu bar 「文件 → 设置… (Ctrl+, / Cmd+,)」. What it looks like:

  ![desktop settings screenshot](../images/desktop-setttings.png)
- **[new]** **Desktop first-run can import config from an existing CLI install** ([PR #43](https://github.com/7as0nch/mimo2codex/pull/43) — A3, thanks @starlsd93-sudo). If `~/.mimo2codex/.env` exists from a prior `npm install -g mimo2codex` install, the desktop Settings window shows a one-click "Import all into desktop" button that copies the API keys / base URLs / proxy vars over to the desktop's per-platform AppData. Existing desktop values are never overwritten — any key already set in the desktop is reported as "skipped". After import, fields are pre-filled in the multi-provider form for review before Save & Restart. Detection honors `~/.mimo2codex-pointer.json`, so users who previously migrated their CLI data directory via the admin UI get the **active** .env imported, not a stale default-location leftover.
- **[new]** **Localized desktop application menu + top-bar "设置" entry** ([PR #43](https://github.com/7as0nch/mimo2codex/pull/43) — A2, thanks @starlsd93-sudo). The Electron default Windows / Linux menu bar was English-only ("File / Edit / View / Window / Help") with no Settings entry — users had to right-click the tray icon, which is unintuitive. v0.5.6 ships a unified Chinese menu on all three platforms (文件 / 编辑 / 视图 / 窗口 / 帮助). "文件 → 设置… (Ctrl+, / Cmd+,)" opens the Electron Settings window directly. As a redundant in-context entry, the admin web UI's header also has a "桌面端设置" button (only rendered inside the desktop shell, gated on `/admin/api/desktop/sentinel`); it travels through a file-based signal channel (`<dataDir>/.desktop-signal.json` written by the sidecar, watched by Electron main) since the admin BrowserWindow has no preload bridge.
- **[new]** **Windows app icon refresh** ([PR #43](https://github.com/7as0nch/mimo2codex/pull/43) — B, thanks @starlsd93-sudo). The contributor supplied a higher-resolution AI-rendered icon set; the orange variant is now wired up as `package/win/icon.ico`. The full set (orange + purple, four sizes each) is preserved under `package/brand/contributed-by-starlsd93/` with provenance notes. macOS `.icns` is untouched in this release — the contribution didn't include `.icns` / `tray-Template*.png`, so a future maintainer pass will refresh those.

---

## v0.5.5

- **[new]** **Windows / macOS desktop app goes GA (no longer beta)**: after the beta-testing window that started with v0.4.8, the desktop app is now stable. Runs mimo2codex in the background; tray / menu-bar icon management; one-click admin UI; auto-update wired up. The CLI install (`npm install -g mimo2codex`) is unchanged and can coexist. Downloads: <https://mimodoc.chengj.online/download>.
- **[fix]** **`tool_search` builtin now supported ([issue #41](https://github.com/7as0nch/mimo2codex/issues/41))**: Codex Desktop's deferred-tool-discovery tool was previously dropped as an unknown type, blocking deferred tool discovery and triggering cascading orphan warnings. It's now translated to a regular function tool — works normally.
- **[fix]** **Connector plugins no longer fail with "unsupported call" ([issue #39](https://github.com/7as0nch/mimo2codex/issues/39))**: GitHub / Canva / HeyGen / Dropbox / Gmail / Google Drive connectors require OpenAI's backend-hosted MCP runtime, which a third-party proxy can't substitute for. mimo2codex now tells the upstream model — the model suggests `shell` + a CLI alternative (e.g. `gh` for GitHub) instead of failing.
- **[fix]** **Capability checks (vision, etc.) now follow the upstream model**: when a runtime override / alias maps the client's `mimo-v2.5-pro` to upstream `mimo-v2.5` (which supports vision), images were still being stripped at the proxy because the check used the client literal. Fixed — capability decisions now follow the real upstream model id, so switching models at runtime takes effect immediately without restart.

---

## (v0.4.10 — 2026-05-24)

- **[fix]** **Codex Desktop namespace tools reporting `unsupported call` ([PR #34](https://github.com/7as0nch/mimo2codex/pull/34), [issue #33](https://github.com/7as0nch/mimo2codex/issues/33), thanks @meesii)**: Codex Desktop's namespace-wrapped tools (e.g. `spawn_agent` under `multi_agent_v1`) failed with `unsupported call` when routed through mimo2codex — the client uses the `namespace` field on each `function_call` output item to dispatch to the correct local handler, and the proxy was dropping it during translation. The fix builds a `toolName → namespaceName` map from the request's `tools` array and re-attaches `namespace` on both non-streaming (`respToResponses`) and streaming (`streamToSse`) outputs. Requests without namespace tools (MiMo / DeepSeek / plain Codex CLI) stay byte-identical.

---

## (v0.4.8 — 2026-05-23)

- **[new]** **Desktop preview (beta) — Windows tray / macOS menu-bar app**: optional Electron companion that runs mimo2codex in the background — no terminal window required. First launch shows a small settings window to pick a provider + paste an API key; after that the tray / menu-bar icon opens the embedded admin UI (either in a window or in your default browser). The sidecar lifecycle (start / stop / restart on settings change) is fully managed; menu **Quit** stops it cleanly. Includes an opt-in "Start on system boot" toggle. The CLI install (`npm install -g mimo2codex`) is unchanged and can coexist on the same machine — the desktop build ships as a separate `v*-desktop` artifact. This is a **beta** — installer, launch, sidecar, and auto-update flows still need real-world miles, so please report friction. Downloads + install guide: <https://mimodoc.chengj.online/download>.
- **[fix]** **CodeX Desktop string-input misidentified as probe ([PR #31](https://github.com/7as0nch/mimo2codex/pull/31), thanks @85339098-afk)**: the OpenAI Responses API allows `input` to be either a string or an array of items; the probe-shape detector in `handleResponses` only matched the array form, so requests like `{model, input: "write hello world"}` (CodeX Desktop's natural shape) were short-circuited to a synthetic 200 with empty `output: []` — looked like the model said nothing, with **no error signal**. The check now also recognizes non-empty string `input`. Logic extracted into an exported `isResponsesProbe()` helper with a focused unit-test suite (`test/server.probe.test.ts`) so this rule can't silently regress.

---

## (v0.4.6 — 2026-05-23)

- **[fix]** **DeepSeek V4 400 `Invalid assistant message: content or tool_calls must be set` ([issue #29](https://github.com/7as0nch/mimo2codex/issues/29))**: when an assistant turn was assembled from a reasoning item + function_call without any visible text part (Codex Chrome plugin pattern), the wire shape became `{role:"assistant", content: null, tool_calls:[…], reasoning_content:"…"}`. DeepSeek's strict validator treats explicit `null` as "neither field present" and rejects. The OpenAI Chat Completions spec says `content` is optional when `tool_calls` is set, so we now OMIT the field instead of setting it to null. Reasoning-only fallback turns (rare: no text, no tools) get `content: ""` to satisfy the spec.
- **[fix]** **Windows / pnpm-global / Node 22 startup crash ([issue #30](https://github.com/7as0nch/mimo2codex/issues/30))**: `mimo2codex` no longer exits when the admin sqlite database can't be opened at startup. Typical cause: pnpm's global install layout didn't fetch a prebuilt `better-sqlite3` binary for the user's Node ABI (`node-v127-win32-x64`), so `new Database()` throws `Could not locate the bindings file`. The proxy now logs a clear, multi-line warning (with the underlying error and a Windows/pnpm-specific hint) and starts with admin DISABLED. Core Codex ↔ Chat-Completions translation never needed the DB and now works out-of-the-box on the install setups that hit this binding gap.

---

## v0.4.5 — 2026-05-22

- **[new]** **Desktop shell (Windows tray / macOS menu bar)**: optional companion app that runs mimo2codex in the background — no terminal window required. First-launch settings window for picking a provider + API key, embedded admin UI from the tray, sidecar lifecycle is fully managed (start / stop / restart on settings change), graceful quit, and an opt-in "Start on system boot" toggle. The CLI flow (`npm install -g mimo2codex`) is completely unaffected; the desktop build is shipped as a separate `v*-desktop` release on GitHub. Downloads + install guide: <https://mimodoc.chengj.online/download>.
- **[opt]** **Desktop Mac builds ship as `.zip` (was `.dmg`)**: multiple GitHub-runner hdiutil versions (macos-14 + macos-15) and dmg formats (UDZO + ULFO) consistently produced technically-valid-but-unmountable `.dmg` images on consumer Macs ("此电脑不能读取你连接的磁盘" / "error 3840"). `.zip` is boring and works everywhere — Finder unzips on double-click, drag `mimo2codex.app` to `/Applications`. The download page detects the format automatically; if a future signed `.dmg` is added we can re-enable that target. SHA256 verification + `xattr -cr` for quarantine clearing are unchanged.
- **[new]** **Proxy support**: mimo2codex's outbound calls honor `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` env vars — same behavior as `curl` / `git`. Declare them in `docker-compose.yml`'s `environment:` for Docker, or `export` from your shell / `.env` for local runs. The startup banner gains a `proxy:` line that echoes the active proxy so env-detection is verifiable at a glance. `MIMO2CODEX_NO_PROXY_FROM_ENV=1` opts out (for users whose shell keeps `HTTPS_PROXY` set for `curl`/`git` but don't want mimo2codex to follow).
- **[opt]** Upstream connect-failure logs carry the underlying cause's `code` and `message` (e.g. `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT`); the same detail flows into the 502 `UpstreamError.message`, making proxy-port typos, DNS failures, and timeouts distinguishable at a glance.
- **[doc]** Proxy FAQ §1 rewritten to spell out "system proxy ≠ process proxy" — Clash / Surge's "system proxy" toggle doesn't auto-export env vars. New 🩺 self-check callout turns the banner's `proxy:` line into a one-glance diagnostic. §5 gains an `ECONNREFUSED <proxy-host>:<proxy-port>` row (including the Docker `127.0.0.1` gotcha).

---

## v0.4.4 — 2026-05-21

- **[new]** **AI documentation assistant on the official docs site ([mimodoc.chengj.online](https://mimodoc.chengj.online/))**: click the bottom-right robot float — drop any common configuration question (first-time setup, why-502, generic-provider wiring, etc.) and the assistant runs a tool-calling agent loop over the project's `doc/*.md` corpus, returning a streamed markdown answer. The reasoning trace is shown in a collapsible "thinking" panel above the answer (auto-collapses once the answer starts). MiMo V2.5 multimodal is wired in — paste / drag / click the paperclip to upload a config screenshot and the AI looks at it before answering. Chat history lives in localStorage per anonymous browser id; clear-conversation button in the drawer header. 

---

## v0.4.2 — 2026-05-21

- **[new]** **Migrate the data directory from the admin UI**: top-right ⚙️ Settings → Local data directory → Migrate. Pick a target path, preview file count + total size, then a live progress bar copies SQLite + `.env` + `providers.json`. The server enters maintenance mode (503) while copying; the original directory is preserved so users can verify the new location before deleting. Auto-rollback on failure (partially-written destination is wiped + the old location is reopened). A persistent banner reminds the user to restart so the new directory takes effect; the resolver priority becomes CLI > env > pointer file (`~/.mimo2codex-pointer.json`) > default `~/.mimo2codex/`.
- **[doc]** **Official docs site goes live at [mimodoc.chengj.online](https://mimodoc.chengj.online/)**: single home for docs and tutorials. The admin footer now points at it directly with a tooltip nudge for stuck users.
- **[fix]** **Hide server-only Codex entries in local mode**: the "Export to local" / "Import from local" buttons and the `History` tab on the Codex 接入 page only make sense in Docker auth deployments (`authMode=on`), where operators ship rendered `auth.json` + `config.toml` bundles between machines. Local single-user runs already write those files directly to `~/.codex/`, so the buttons were noise. Now gated on `authMode === "on"`.

---

## (v0.3.0 — coming)

- **[new]** **Docker auth deployment goes GA**: after v0.2.17 served as the preview, the **Docker auth mode** is now a stable feature — user registration / login, per-user m2c proxy API keys, BYOK (bring-your-own upstream key), Gitee / GitHub OAuth, downloadable Codex client config bundles. Put mimo2codex behind Docker / an internal network / a small private circle without leaking the upstream key. Local single-user runs (`authMode` defaults to `off`) are unaffected. Full guide: [doc/auth-deployment.md](./auth-deployment.md) — covers Docker compose, first-run bootstrap, OAuth setup, and troubleshooting.
- **[fix]** **Tool list dedup defense ([issue #20](https://github.com/7as0nch/mimo2codex/issues/20))**: newer Codex CLI / Desktop / DeX builds emit duplicate tool names (typical shape: a top-level `_fetch` function plus a `namespace`-wrapped `_fetch` that flattens to a second copy), causing MiMo to 400 with `"tools contains duplicate names: _fetch"`. reqToChat now dedupes by `function.name` / builtin `type` keep-first after the merge step; duplicates are logged at `WARN` so users can spot the client-side bug.
- **[new]** **Mixed-mode thinking history defense**: when conversation history contains assistant messages without `reasoning_content` (typical scenario: user toggled the thinking switch mid-session), automatically backfill those messages with the placeholder `"(this turn ran without thinking mode)"`. **Thinking stays ON** — avoids upstream MiMo / DeepSeek 400 `"reasoning_content must be passed back"`. Logs a paired INFO line.
- **[opt]** Quieter console log: `WARN client model rewritten on the way upstream` → `INFO model fallback applied — client sent unknown model id, request continues with provider default`. Demoted to INFO + rephrased; it was always a graceful fallback (request succeeds), not an error.
- **[doc]** New bilingual [Proxy / Network FAQ](./proxy-faq.md): mac & win proxy setup, error-code lookup (502 / ECONNREFUSED / DNS / TLS-MITM, etc.), origin of the `gpt-5.4` placeholder, mixed-mode thinking history explainer.
- **[doc]** New bilingual [Tag Log](./tag-log.md): migrated out of the README's `<details>` changelog block; sorted newest-first with `[new]/[fix]/[opt]/[doc]` categorization across all 44 historical tags.

---

## v0.2.17 — 2026-05-19

- **[new]** **Docker auth mode (preview)**: users can register, log in, and generate their own m2c (mimo2codex proxy) API key. For Docker / intranet / small private deployments, replace `OPENAI_API_KEY`'s `mimo2codex-local` placeholder with the generated m2c key — protects the upstream key from being abused. Single-user local runs (`authMode` defaults to `off`) are unaffected.

> ⚠️ **v0.2.17 is a preview release** — the first cut of the Docker auth deployment. **v0.3.0 is the GA**. For production use, please run v0.3.0+. See [Auth & deployment](./auth-deployment.md).

## v0.2.16 — 2026-05-19

- **[opt]** Admin UI tightening: denser layout, dropped redundant displays, reduced visual noise.

## v0.2.15 — 2026-05-18

> Includes betas `v0.2.15-beta.0/1/2` (SenseNova model adaptation + thinking fine-tuning + Kimi adaptation).

- **[new]** **Thinking mode admin UI**: the "Codex Enable" page gains a global **Thinking** card.
  - **Thinking ON/OFF**: persists into the settings DB; no more `--disable-thinking` restart. Takes effect immediately on the next request. OFF makes every provider skip thinking (`thinking:{type:"disabled"}` for mimo / deepseek, `reasoning_effort:"none"` for sensenova / other generic).
  - **Force high reasoning effort**: when Codex didn't pass `reasoning.effort`, mimo2codex fills in `reasoning_effort:"high"`. Disabled by default with a visible side-effect warning (billing can spike). CLI `--disable-thinking` still wins.
- **[new]** **Kimi (Moonshot) preset**: typing `https://api.moonshot.cn/v1` (or `moonshot.ai`) as baseUrl is auto-recognized and applies `dropReasoningEffort: true`, so Kimi (which uses `thinking:{enabled/disabled}` instead of `reasoning_effort`) doesn't 400 on the unknown field. Models: `kimi-k2.6` / `kimi-k2.5` / `kimi-k2-thinking` / `kimi-k2-thinking-turbo` / `moonshot-v1-{8k,32k,128k}`. See [doc/kimi.md](./kimi.md).
- **[new]** **Docker deployment**: new `Dockerfile` (multi-stage alpine, ~70MB), `.dockerignore`, GitHub Actions workflow that auto-builds **multi-arch `linux/amd64 / linux/arm64` images and pushes to ghcr.io/7as0nch/mimo2codex**; bundled `docker-compose.yml` for one-command launch with **the data dir bind-mounted to local `./.mimo2codex/`** (sqlite + providers.json + admin UI config persist across container rebuilds); env supports both `.env` mount and `-e` / `environment:` injection. macOS / Windows / Linux. Based on [#15](https://github.com/7as0nch/mimo2codex/pull/15) (thanks @hufang360).
- **[new]** SenseNova model adaptation (from betas).

## v0.2.14 — 2026-05-15

- **[fix]** Added inline comments to `.env.example` so first-time users don't miss what each field means.

## v0.2.13 / v0.2.12 / v0.2.11 / v0.2.10 — 2026-05-15

- **[new]** Version-update check (queries the upstream npm registry for newer releases). Iterated through four patches to refine network tolerance, caching, and message phrasing.

## v0.2.9 — 2026-05-15

- **[new]** Universal `.env` config: `mimo2codex init` then fill in keys — same config across platforms.

## v0.2.8 — 2026-05-15

> MiniMax / strict OpenAI-compatible upstream support patchset (PR #12).

- **[fix]** `reqToChat`: no longer sends `strict: null` upstream (MiMo's Pydantic schema rejects null and 400s with `"Input should be a valid boolean"`). Fixes [issue #11](https://github.com/7as0nch/mimo2codex/issues/11).
- **[fix]** `minimax-compat`: one-click preset no longer strips `stream_options` / `parallel_tool_calls` by default.
- **[feat]** `minimax-compat`: inline `<think>...</think>` on the response side is split into `reasoning_content`.
- **[feat]** Admin webui providers form: new "Strict OpenAI compat" switch group (covers minimaxCompat etc.).
- **[feat]** Generic provider gains the MiniMax-compat patch ([issue #7](https://github.com/7as0nch/mimo2codex/issues/7)).

## v0.2.7 — 2026-05-15

- **[new]** Full admin webui rewrite on **Ant Design 5**: dark/light themes, EN/中文 i18n, viewport-locked sider + footer, smoothed Token-usage curves.
- **[new]** `.env.example` + **Bash / PowerShell one-liner key-loader scripts** (`.env` is gitignored).
- **[new]** Per-model **⚡Probe** button on "Codex Enable": fires a minimal ping to validate key / baseUrl / model id end-to-end.
- **[new]** Token-usage chart folds in **cache-hit bars** (green = hits, gray ghost = prompt totals) plus a window-wide hit-rate summary.
- **[new]** Customizable Codex dir via settings or the `CODEX_HOME` env var.

> Includes betas `v0.2.6-beta.1/2/3`: MiMo models' `contextWindow` 128K → 1M (matching DeepSeek; fixes Codex 256K-config 400); webui refactor PR #1~#6 (antd 5 base, Setup/Models/CodexEnable theming, Logs table, Dashboard cache-hit overlay, viewport lockdown, etc.).

## v0.2.6 — 2026-05-14

- **[new]** **"Codex Enable" page** (**replaces cc-switch**): admin webui writes `~/.codex/auth.json` + `config.toml` in one click.
- **[new]** **Runtime override**: swap upstream models without restarting Codex.
- **[new]** Permanent backup retention + half-broken pair recovery + manual deletion: originals are auto-backed-up, and **the first backup capturing your real external auth.json is permanently preserved** — switch models 100 times and you can still restore the original Codex config.
- **[fix]** `removeOrphanToolMessages`: drops orphan tool messages on DeepSeek V4 session desync, preventing 400 `"Messages with role 'tool' must be a response to..."` ([PR #10](https://github.com/7as0nch/mimo2codex/pull/10) / [issue #8](https://github.com/7as0nch/mimo2codex/issues/8)).
- See [doc/codex-enable.md](./codex-enable.md).

## v0.2.5 — 2026-05-14

> Includes beta `v0.2.5-beta.1`.

- **[feat]** MiMo / DeepSeek docs aligned.
- **[fix]** DeepSeek `tool_calls` 400 fix.
- **[feat]** Friendly context-overflow error: surfaces a readable `/compact` hint instead of a raw 400.
- **[feat]** Beta release workflow (`npm run release:beta`).

## v0.2.4 — 2026-05-13

- **[test]** Added two-stage priority regression tests for `selectProvider`.
- **[doc]** Generic-provider routing-priority docs updated to match.

## v0.2.3 — 2026-05-13

- **[fix]** Fixed MiMo `reasoning_content` round-trip per Xiaomi's [official guidance](https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/passing-back-reasoning_content).

## v0.2.2 — 2026-05-13

- **[fix]** GitHub Actions workflow fix.

## v0.2.1 — 2026-05-12

- **[new]** Added `mimoskill` — Python helpers for image generation, OCR, etc. (stdlib only, no pip).

## v0.1.16 ~ v0.1.19 — 2026-05-12

- **[new]** Early `mimoskill` iteration (v0.1.17 ~ v0.1.19): image gen / OCR / pet generation, polished step by step.
- **[new]** v0.1.16: support for additional models with `wireApi="responses"` direct passthrough (in addition to the default mimo / deepseek chat-translation path).

## v0.1.15 — 2026-05-12

- **[fix]** Registered `mimo-v2.5` vision model in the builtin catalog so it no longer silently falls back to `mimo-v2.5-pro` (which would drop images).

## v0.1.1 ~ v0.1.14 — 2026-05-09 ~ 2026-05-10

Early-project iteration (v0.1.1 was the first public release on 2026-05-09). No detailed changelog kept for this phase; main work:

- mimo / deepseek dual-provider scaffolding.
- Responses API ↔ Chat Completions bidirectional translation core (`reqToChat` / `respToResponses` / `streamToSse`).
- First-cut admin webui (Tokens / Logs / Settings pages).
- SQLite persistence (chat logs, model catalog, runtime settings).
- CLI: `mimo2codex init` / `update` / `print-config` / `print-cc-switch`.

Browse the full commit stream with `git log v0.1.1..v0.1.14 --oneline`.

---

## Release commands

Defined in [package.json](../package.json):

```bash
npm run release:patch    # x.y.Z+1
npm run release:minor    # x.Y+1.0
npm run release:major    # X+1.0.0
npm run release:beta     # pre-release
```

Full runbook: [PUBLISHING.md](../PUBLISHING.md) (repo root).
