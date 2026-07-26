# 通用 OpenAI 兼容 Provider · 详细教程

> [English](./generic-providers.md) · 中文
>
> 返回：[README 中文](../README.zh.md) · [README English](../README.md)

mimo2codex 内置了 MiMo 和 DeepSeek 两个 provider。**通用 provider 机制**让你能在不改任何代码、不重新发包的前提下，把任何 **OpenAI Chat Completions 兼容**或**原生 Responses API** 的上游接到新版 Codex —— Qwen、GLM、Kimi、智谱、OpenAI 本身、本地 vLLM、Ollama、LM Studio …… 凡是接口长得像 OpenAI 的都能接。

## 它解决什么

新版 Codex 强制走 `wire_api = "responses"`，绝大多数三方模型只对外提供 Chat Completions。mimo2codex 把这个翻译做掉，你只需要在配置里登记一下你的上游就行。

支持两种「上游协议」：

| `wireApi` | 上游协议 | 适用场景 |
|---|---|---|
| `chat`（默认） | OpenAI Chat Completions | 99% 的第三方厂商（Qwen / GLM / DeepSeek / Kimi / Ollama / vLLM …） |
| `responses` | OpenAI Responses API | 上游已经原生支持 Responses（如 OpenAI 自家、未来想跟进的厂商）。直透模式，不做协议翻译 |

`responses` 直透有个额外优点：**协议升级时不用等 mimo2codex 跟进**——上游加什么字段就转什么字段，不会被中间层的旧翻译卡住。

## 60 秒上手

**最简方式**：一个 env，三件套。

```bash
export GENERIC_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export GENERIC_API_KEY=sk-your-qwen-key
export GENERIC_DEFAULT_MODEL=qwen3-max
mimo2codex --model generic
```

启动横幅会显示 `provider: generic`、`upstream: https://dashscope...`，然后 `mimo2codex print-config --model generic` 把 `auth.json + config.toml` 两段打印出来，复制到 `~/.codex/` 即可。

> ⚠️ env-only 模式只能配 **一个** 上游。要同时配多个，用下面的 `providers.json`。

## 配置文件方式（多实例，推荐）

写一个 `providers.json`，每个上游一项。默认路径：

| 系统 | 路径 |
|---|---|
| macOS / Linux | `~/.mimo2codex/providers.json` |
| Windows | `%USERPROFILE%\.mimo2codex\providers.json` |

也可以用 `MIMO2CODEX_PROVIDERS_FILE=/some/path/providers.json` 显式指定。

完整示例：

```json
{
  "providers": [
    {
      "id": "qwen",
      "shortcut": "qwen",
      "displayName": "Qwen (DashScope)",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "envKey": "QWEN_API_KEY",
      "defaultModel": "qwen3-max",
      "wireApi": "chat",
      "models": [
        { "id": "qwen3-max", "contextWindow": 262144 },
        { "id": "qwen3-coder-plus", "contextWindow": 1048576 }
      ],
      "features": { "forceParallelToolCalls": true }
    },
    {
      "id": "kimi",
      "shortcut": "kimi",
      "displayName": "Kimi K2",
      "baseUrl": "https://api.moonshot.cn/v1",
      "envKey": "KIMI_API_KEY",
      "defaultModel": "kimi-k2-0905-preview"
    },
    {
      "id": "ollama",
      "shortcut": "ol",
      "displayName": "Ollama (local)",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "envKey": "OLLAMA_API_KEY",
      "defaultModel": "qwen2.5-coder:7b"
    },
    {
      "id": "openai-native",
      "displayName": "OpenAI (native Responses)",
      "baseUrl": "https://api.openai.com/v1",
      "envKey": "OPENAI_API_KEY",
      "defaultModel": "gpt-5",
      "wireApi": "responses"
    }
  ]
}
```

配好之后启动：

```bash
export QWEN_API_KEY=sk-...
export KIMI_API_KEY=sk-...
mimo2codex --model qwen        # 默认 provider 是 qwen
```

`--model` 接收 `id` 或 `shortcut`（上面例子里 `qwen` 既是 id 又是 shortcut，`ollama` 的 shortcut 是 `ol`）。

## 字段一览

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `id` | ✓ | — | 唯一标识。不能用 `mimo` / `deepseek`（保留）。只允许字母数字 / `-` / `_` |
| `displayName` | — | id | UI 和 print-config 里显示的名字 |
| `shortcut` | — | id | `--model <短码>` 用 |
| `baseUrl` | ✓ | — | 上游 base URL（**不要**带 `/chat/completions` 后缀，mimo2codex 自己拼） |
| `envKey` | ✓ | — | 从哪个环境变量读 API key（如 `QWEN_API_KEY`） |
| `defaultModel` | ✓ | — | 客户端没指定 / 未识别 model 字段时的兜底 |
| `wireApi` | — | `"chat"` | `"chat"` 或 `"responses"`，见上文 |
| `models` | — | `[]` | 声明该 provider 的模型清单（详见下节） |
| `features.forceParallelToolCalls` | — | `false` | 强制开启 `parallel_tool_calls: true`（agentic 编程任务推荐打开） |
| `features.webSearch` | — | `false` | 把 Codex 的 `web_search` 工具透传给上游（仅对支持 builtin web_search 的上游有意义） |
| `features.minimaxCompat` | — | `false` | **MiniMax 一键预设**：默认包揽 `dropNullStrict` + `dropNullContent` + `dropToolChoiceAuto` + `mergeSystemMessages` + `extractThinkTags` 共 5 个开关。`dropStreamOptions` / `dropParallelToolCalls` **不**在预设里（它们是 OpenAI 标准字段，删了会让 token 统计变 0）。详见 [minimax.zh.md](./minimax.zh.md) |
| `features.dropNullStrict` | — | `false` | 删 `tools[*].function.strict === null`（MiniMax 拒绝 null） |
| `features.dropNullContent` | — | `false` | 删 assistant `content === null` 字段（MiniMax 拒绝 null） |
| `features.dropToolChoiceAuto` | — | `false` | 删 `tool_choice === "auto"`（默认值；MiniMax 拒绝显式传） |
| `features.dropStreamOptions` | — | `false` | 删 `stream_options`。⚠️ 上游将不再回传 `usage` → admin DB token 统计会变 0。**不**在 `minimaxCompat` 预设里 |
| `features.dropParallelToolCalls` | — | `false` | 删 `parallel_tool_calls`。**不**在 `minimaxCompat` 预设里 |
| `features.mergeSystemMessages` | — | `false` | 合并所有 `role: "system"` 消息为单条前置（MiniMax 只接受 1 条） |
| `features.extractThinkTags` | — | `false` | 响应侧：把 `content` 里的 `<think>...</think>` 块切到 `reasoning_content`（MiniMax M1/M2/M3、GLM/Qwen-thinking 等使用 inline 思考） |
| `forceDefaultModel` | — | `false` | 当 `models: []` 时让 resolveModel 返回 null，未知 model 名改写到 `defaultModel`。配 MiniMax env-var 单实例使用 |
| `docsUrl` | — | — | "缺 API key" 错误消息里展示的链接 |

`models[]` 每一项：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 上游真实 model id |
| `aliases` | — | 客户端可能发的别名，路由时也算命中 |
| `displayName` | — | UI 上显示的名字 |
| `contextWindow` | — | print-config 里的 `model_context_window` |
| `maxOutputTokens` | — | print-config 里的 `model_max_output_tokens` |
| `supportsImages` / `supportsReasoning` / `supportsWebSearch` | — | 元信息，UI 展示用 |

## 模型识别策略

`models[]` **不是必填**。两种行为：

**1. 声明了 `models[]`（严格模式）**

只有列在 `models[]` 里的 id（及 alias）才算"属于这个 provider"。请求按 model id 精确匹配到 provider。客户端发了未在列表里的 id：
- 如果该 provider 是**默认** provider → 把 model 重写为 `defaultModel`，并在日志里记一条 `rewriteNotice`
- 否则不命中，走默认 provider 的兜底

适合：知道自己用哪几个模型，想让 print-config 输出 `model_context_window`、想在 admin UI 看到清晰的模型清单。

**2. 不写 `models[]`（任意透传）**

客户端发什么 model id，就原样转发给上游。**不重写**、**不报错**。

适合：上游模型清单变化快（Ollama、OpenRouter 这类聚合服务），或者你只想"管道"功能，不想每加一个模型就改配置。

> 任意透传 provider **不会** 被自动 model-id 匹配命中——避免它"吞掉"所有 mimo / deepseek 的模型。要路由到它，必须把它设为默认 provider（`--model <id>`）。

### 路由优先级

同一个 model id 可能被多个 provider 声明（典型场景：你为内部 MiMo 代理建了个 generic provider，`models[]` 里也写了 `mimo-v2.5-pro`）。`selectProvider` 按下面的顺序挑：

1. **带 key 的用户自定义 generic**（`models[]` 非空），按注册顺序匹配
2. **带 key 的内置 provider**（mimo / deepseek）
3. **默认 provider 兜底**——这里会把 model id 重写为默认 provider 的 `defaultModel`，并伴随一条 `rewriteNotice` 警告日志

第 1 步把 generic 排在内置前面，是为了让"内部代理"场景能正常工作：当你只配了 `COMPANY_MIMO_API_KEY`、没配 `MIMO_API_KEY` 时，客户端发 `mimo-v2.5-pro` 仍然能路由到你的 generic（而不是因为内置 mimo 没 key 就掉到默认 provider）。如果同一 model id 被多个带 key 的 generic 声明，最先注册的赢。

## wireApi 详解

**`chat`**：mimo2codex 把 Codex Responses 请求翻译成 Chat Completions，发到 `${baseUrl}/chat/completions`，再把上游响应翻译回 Responses 给 Codex。

```
Codex ──[Responses]──> mimo2codex ──[Chat]──> 上游 ──[Chat]──> mimo2codex ──[Responses]──> Codex
```

**`responses`**：mimo2codex 把 Codex 的请求**直接转发**到 `${baseUrl}/responses`，不做任何翻译；上游响应也原样返回。

```
Codex ──[Responses]──> mimo2codex ──[Responses raw]──> 上游 ──[Responses raw]──> mimo2codex ──> Codex
```

什么时候用 `responses`：

- 上游就是 OpenAI 自家
- 上游声称"完全兼容 OpenAI Responses API"
- 上游有 chat completions 不支持的字段（如 `reasoning.effort`、`text.verbosity`、新工具类型），翻译层会丢字段时

注意事项：

- 流式直透是**字节级 pipe**——上游 SSE 帧原样转发到 Codex，Codex 端 SSE 解析器负责切帧。低开销但也意味着 mimo2codex 不在中间做任何修改
- 当前 admin UI 的"按模型 token 统计"对 `responses` 路径只能提取 `usage` 字段顶层，复杂的 usage breakdown 不解析

## 几个真实上游配置

### 阿里通义千问（DashScope OpenAI 兼容模式）

```json
{
  "id": "qwen",
  "displayName": "Qwen (DashScope)",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "envKey": "QWEN_API_KEY",
  "defaultModel": "qwen3-max",
  "models": [
    { "id": "qwen3-max", "contextWindow": 262144 },
    { "id": "qwen3-coder-plus", "contextWindow": 1048576, "supportsReasoning": true }
  ],
  "features": { "forceParallelToolCalls": true }
}
```

### 智谱 GLM

```json
{
  "id": "glm",
  "displayName": "Zhipu GLM-4.6",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "envKey": "ZHIPU_API_KEY",
  "defaultModel": "glm-4.6",
  "models": [
    { "id": "glm-4.6", "contextWindow": 200000 }
  ]
}
```

### Moonshot Kimi

```json
{
  "id": "kimi",
  "displayName": "Kimi K2",
  "baseUrl": "https://api.moonshot.cn/v1",
  "envKey": "KIMI_API_KEY",
  "defaultModel": "kimi-k2-0905-preview",
  "models": [
    { "id": "kimi-k2-0905-preview", "contextWindow": 256000 }
  ]
}
```

### 本地 Ollama / LM Studio（任意透传）

```json
{
  "id": "ollama",
  "shortcut": "ol",
  "displayName": "Ollama (local)",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "envKey": "OLLAMA_API_KEY",
  "defaultModel": "qwen2.5-coder:7b"
}
```

Ollama 不验证 API key，但 `envKey` 是 schema 必填——随便给个值就行（`OLLAMA_API_KEY=ignored`）。

### OpenAI 原生 Responses（直透）

```json
{
  "id": "openai-native",
  "displayName": "OpenAI (native Responses)",
  "baseUrl": "https://api.openai.com/v1",
  "envKey": "OPENAI_API_KEY",
  "defaultModel": "gpt-5",
  "wireApi": "responses"
}
```

### MiniMax（严格 OpenAI 兼容）

MiniMax 拒绝若干 OpenAI / MiMo / DeepSeek 都接受的字段。开 `minimaxCompat` 一键预设即可：

```json
{
  "id": "minimax",
  "displayName": "MiniMax M3",
  "baseUrl": "https://api.minimax.io/v1",
  "envKey": "MINIMAX_API_KEY",
  "defaultModel": "MiniMax-M3",
  "models": [
    { "id": "MiniMax-M3", "contextWindow": 1000000 },
    { "id": "MiniMax-M2.7", "contextWindow": 204800 }
  ],
  "features": {
    "minimaxCompat": true,
    "forceParallelToolCalls": true
  }
}
```

同一份预设也会匹配 `https://api.minimaxi.com/v1`。`MiniMax-M3` 是 1,000,000 token 默认档；如果还要 204,800 token 的 `MiniMax-M2.7`，就保留它的模型项。

详见 [minimax.zh.md](./minimax.zh.md)（含 env-var 单实例写法 `GENERIC_FORCE_DEFAULT_MODEL=1`）。

## 默认 provider 与路由规则（重要）

加了 generic provider 之后，路由优先级：

1. **客户端发的 model 字段命中某个 provider 的 `models[]`（含 alias）且该 provider 有 key** → 路由到该 provider
2. **命中了 catalog 但 provider 没 key** → fall through 到默认 provider，model 被重写为 `defaultModel`，日志记 `client_model_rewritten`
3. **没声明 `models[]` 的 provider（开放目录）** → 在自动路由阶段跳过（避免"吞掉"所有未知 id）；只有显式 `--model <id>` 设它为默认 provider 时才会被路由到
4. **都不命中** → 走默认 provider，model 被重写为 `defaultModel`，日志记 `client_model_rewritten`

默认 provider 的选择：

- `--model <id-or-shortcut>` 优先
- 否则 `MIMO2CODEX_DEFAULT_PROVIDER` 环境变量
- 否则 fallback 到 `"mimo"`

### "key 没设" 的实际后果

举个常见的坑：你在 `providers.json` 配了 qwen / kimi / glm 三个 generic，但启动时只设了 `MIMO_API_KEY`。这种情况下：

```bash
# 客户端发 qwen3-max
# → byClientModel 命中 qwen catalog
# → qwen 没 key → fall through
# → 走默认 provider mimo → model 重写为 mimo-v2.5-pro
# → 实际由 MiMo 用 mimo-v2.5-pro 回答
```

**对话过程没有任何提示**。在 admin 的「模型映射记录」表里能看到 `qwen3-max → mimo-v2.5-pro` 这条映射，chat 日志里也会带 `client_model_rewritten` 错误码。但如果你不主动看 admin UI，很容易以为「在用 qwen」实际「在用 mimo」。

要避免这个静默降级，目前两个办法：

1. **启动前确认 key 全配齐**：admin 首页的 Provider 卡片明确显示每个 provider「已检测到 key / 未检测到 key」，把所有需要用到的 key 都设上
2. **改用单 provider 启动**：要专门用 qwen 就 `--model qwen` 并把 mimo 的 key 拿掉——这样如果 qwen 没 key 启动会直接报错而不是静默降级

> 既有的 mimo / deepseek 用户**完全不受影响**：不写 providers.json 时默认 provider 仍是 mimo，所有行为字节级一致。

## 在 admin webui 配置（不用手写 JSON）

打开 `http://127.0.0.1:8788/admin/`：

- **通用 Provider 页**（侧栏，[`/admin/providers`](http://127.0.0.1:8788/admin/providers)）：可视化增删改查 generic providers
  - 表格列出 `providers.json` 里所有条目，每条可「编辑」/「删除」
  - 「+ 添加 Provider」弹出表单，所有字段都有占位符提示和实时校验（id 不能与内置冲突 / 不能含空格 / baseUrl 必填等）
  - 模型清单可动态增删，每个模型可填 contextWindow / maxOutputTokens / vision / reasoning / web search 等元信息
  - 「编辑原始 JSON」逃生口——直接编辑 `providers.json` 全文，校验通过才会写入
  - 保存后写 `~/.mimo2codex/providers.json`，UI 提示 **「重启 mimo2codex 让配置生效」**——目前不做热重载，启动期一次性加载
- **对接指引页**（[`/admin/setup`](http://127.0.0.1:8788/admin/setup)）：下拉选 provider，三个 Tab 自动渲染 `auth.json + config.toml` 三种粘贴方式（直接修改 / env-key / cc-switch），每个 codeblock 有「复制」按钮
- **概览页**：所有已注册 provider（含 generic）列在 Provider 卡片里，显示 key 是否已配置
- **日志页**：按 provider 过滤（generic id 直接出现在下拉里）

> 注意：UI 编辑**不能管理 API key**——key 不存数据库、不写配置文件，必须通过环境变量注入（如 `QWEN_API_KEY=sk-...`）。这是为了避免凭据落盘后被备份/泄漏。UI 只管 schema 配置，env 管 secret。

## CLI 子命令对 generic 的支持

```bash
mimo2codex print-config --model qwen          # 输出 qwen 的 auth.json + config.toml 片段
mimo2codex print-config --model qwen --env-key  # env-key 变种（仅 Codex CLI 适用）
mimo2codex print-cc-switch --model qwen       # cc-switch 自定义供应商片段
```

toml 输出里 `model_provider` 命名规则：

- mimo → `[model_providers.mimo]`（保留历史）
- deepseek → `[model_providers.mimo2codex]`（保留历史）
- 其他 generic → `[model_providers.mimo2codex-<id>]`（加前缀避免与用户已有 toml 段冲突）

## 故障排查

<details>
<summary><b>报 <code>provider id "xxx" must be alphanumeric + dash/underscore</code></b></summary>

`id` 字段只允许字母数字、`-`、`_`，不能有空格、点、斜杠。改成 `kimi`、`my-qwen`、`local_dev` 这样的。

</details>

<details>
<summary><b>报 <code>generic provider id "mimo" conflicts with a built-in provider</code></b></summary>

`mimo` 和 `deepseek` 是保留 id。改成 `mimo-custom` 之类的。

</details>

<details>
<summary><b>报 <code>missing API key for ...</code> 但我明明设了 env</b></summary>

检查：
1. env 变量名是否和 spec 里的 `envKey` 完全一致（区分大小写）
2. 是否用对了 shell：PowerShell 设的 `$env:X` 在 cmd 看不到，反之亦然
3. 是不是把 key 设到了 `MIMO2CODEX_DEFAULT_PROVIDER` 指定的 provider 上（默认必须有 key，否则启动报错）

</details>

<details>
<summary><b>启动横幅没显示我的 generic provider</b></summary>

- 横幅只显示**有 API key**的 provider。检查 `envKey` 是否设了
- 检查 providers.json 路径：是否在 `~/.mimo2codex/`，或显式 `MIMO2CODEX_PROVIDERS_FILE`
- JSON 语法错会启动失败并打错误，不会静默

</details>

<details>
<summary><b>路由没按预期走 — 发 qwen3-max 却到了 mimo</b></summary>

如果你的 generic provider 没声明 `models[]`，它**不会**被 `byClientModel` 自动命中。两条路：
- 给 spec 加 `models: [{ "id": "qwen3-max" }]`（推荐）
- 或者把 generic 设为默认 provider：`mimo2codex --model qwen`

</details>

<details>
<summary><b>上游报 400，错误信息说不认识 reasoning / thinking 字段</b></summary>

非 MiMo 的上游通常不支持 MiMo 特有的 `thinking` 字段。generic provider 已经默认会剥掉这些字段。如果还报错，**用 `--verbose` 看实际转发的 body**——可能是 Codex 端发了别的字段，那是 Codex 客户端的兼容性问题，与代理无关。

</details>

<details>
<summary><b>wireApi: "responses" 上游返回 404 / 405</b></summary>

上游可能根本没实现 `/v1/responses` 端点。绝大多数三方厂商目前只有 `/v1/chat/completions`——把 `wireApi` 改回 `"chat"`（或删掉，默认就是 chat）。

</details>

<details>
<summary><b>同一个 id 在 providers.json 里出现两次</b></summary>

启动会报错并退出。每个 id 必须唯一。

</details>

## 设计取舍备忘

- **为什么默认 provider 仍是 mimo？** 向后兼容。既有 mimo / deepseek 用户升级到带 generic 支持的版本，行为零变化
- **为什么开放目录的 generic 不参与 `byClientModel`？** 否则它会"吞掉"所有未知 model id，包括 mimo / deepseek 的合法 id。把开放目录 generic 设为默认 provider 才能用它做"全部 model 透传"
- **为什么 toml provider key 加 `mimo2codex-` 前缀？** 用户的 `~/.codex/config.toml` 里可能已经有 `[model_providers.qwen]`（直接连 Qwen 的旧配置），用前缀避免被覆盖
- **为什么不做 admin UI 的可视化编辑？** 第一版先把"可用"做出来。后续 UI 表单可以在不破坏现有架构的情况下加入（providers.json 反正本来就是配置文件）

## 相关源码

- [src/providers/generic.ts](../src/providers/generic.ts) — 工厂函数
- [src/providers/genericLoader.ts](../src/providers/genericLoader.ts) — 配置加载 + env 兜底
- [src/providers/registry.ts](../src/providers/registry.ts) — 运行时注册 + 路由防护
- [src/upstream/openaiCompatClient.ts](../src/upstream/openaiCompatClient.ts) — chat / responses 两个上游客户端
- [src/server.ts](../src/server.ts) — `handleResponses` 里的 wireApi 分支
- [test/providers.generic.test.ts](../test/providers.generic.test.ts) — 18 个测试用例
