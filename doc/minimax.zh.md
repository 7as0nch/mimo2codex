# 接入 MiniMax

> English: [minimax.md](./minimax.md)

MiniMax（`https://api.minimax.io/v1` / `https://api.minimaxi.com/v1`）兼容 OpenAI Chat Completions 规范，但对请求字段的校验比 OpenAI 自家 / MiMo / DeepSeek 都更严格。直连 mimo2codex 的通用 generic provider 时会撞到几个非显然的报错。本文档说明如何用 v0.2.8+ 的 MiniMax 适配开关一键解决。

来源：[issue #7](https://github.com/7as0nch/mimo2codex/issues/7)

## 症状（修复前）

多轮工具调用时 MiniMax 返回：
- `invalid chat setting (2013)`
- `invalid message role: system (2013)`
- `unknown model 'gpt-5.5' (2013)`

Codex 桌面端表现为：第一轮请求可能成功，进入 function_call → function_call_output 第二轮就崩。

## 根因

MiniMax 比其他 OpenAI-compatible 上游严：

| 字段 | OpenAI / DeepSeek | MiMo | MiniMax |
|---|---|---|---|
| `tools[*].function.strict: null` | 接受 | **拒绝**（issue #11） | **拒绝** |
| assistant 消息 `content: null`（同消息带 tool_calls）| 接受 | **拒绝** |
| `tool_choice: "auto"`（显式） | 接受 | **拒绝**（要求省略） |
| `stream_options.include_usage` | 接受 | **拒绝**（非标准扩展） |
| `parallel_tool_calls` | 接受 | **拒绝**（非标准扩展） |
| 多条 `role: "system"` 消息 | 接受 | **拒绝**（只允许 1 条，且必须在最前） |

Codex 还会以请求里 `config.toml` 配置的 model 名（如 `gpt-5.5`）作为字面值发上来，MiniMax 不识别 → 直接 400。

**另一个常见困惑** —— MiniMax 的 thinking 内容用 inline `<think>...</think>` 包裹在 `content` 字段里，而 mimo2codex 默认按 DeepSeek/MiMo 风格从单独的 `reasoning_content` 字段读思考。不切分的话 Codex 客户端会把 `<think>...</think>` 当作正常 assistant 文本直接显示给用户。`features.extractThinkTags`（含在 `minimaxCompat` 一键预设里）会把这些块从 content 切到 reasoning_content，行为对齐 DeepSeek-R1。

## 推荐配置（providers.json）

在 `~/.mimo2codex/providers.json` 写入：

```json
{
  "providers": [
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
      "features": { "minimaxCompat": true, "forceParallelToolCalls": true }
    }
  ]
}
```

同一份配置也会匹配 `https://api.minimaxi.com/v1`。`MiniMax-M3` 是 1,000,000 token 默认档；如果还要用 204,800 token 的 `MiniMax-M2.7`，就保留它的模型项。

设环境变量并启动：
```bash
export MINIMAX_API_KEY=<your_key>
mimo2codex --model minimax
```

打开 webui (`http://127.0.0.1:8788/admin/`) 在模型行点 **"探测"** 按钮一键自验链路。

## 简易配置（env-var 单实例）

如果只想跑 MiniMax，不打算 providers.json：

```bash
export GENERIC_BASE_URL=https://api.minimax.io/v1
export GENERIC_API_KEY=<your_key>
export GENERIC_DEFAULT_MODEL=MiniMax-M3
export GENERIC_FORCE_DEFAULT_MODEL=1   # 关键：未知模型名（如 "gpt-5.5"）自动改写到 MiniMax-M3
mimo2codex
```

⚠️ **env-var 模式无法传 `features.minimaxCompat`**——想用严格模式开关请改用 providers.json。

如果你还要 204,800 token 的 `MiniMax-M2.7`，请改用 providers.json 并在其中声明该模型项。

## 字段说明

### 顶层

| 字段 | 默认 | 作用 |
|---|---|---|
| `forceDefaultModel` | `false` | 当 `models: []` 时，让 `resolveModel` 返回 null，触发 selectProvider fallback 把请求 model 改写为本 provider 的 `defaultModel`。MiniMax 用 env-var 单实例时必开。 |

### `features.*`（MiniMax 兼容子开关）

全部默认 `false`。开 `minimaxCompat: true` 默认包揽下面**带 ✅ 的 5 个**子开关。`dropStreamOptions` / `dropParallelToolCalls` **不**在一键预设里——因为这两个是 OpenAI 官方规范字段，MiniMax 接受，而且 `stream_options.include_usage` 是 admin DB token 统计的来源。

| 字段 | 一键预设 | 删什么 |
|---|---|---|
| `minimaxCompat` | — | **一键预设**（包揽下面带 ✅ 的子开关） |
| `dropNullStrict` | ✅ | `tools[*].function.strict === null`（保留显式 true/false） |
| `dropNullContent` | ✅ | assistant 消息上 `content === null` 字段 |
| `dropToolChoiceAuto` | ✅ | `tool_choice === "auto"`（"auto" 即默认值） |
| `mergeSystemMessages` | ✅ | 合并所有 `role: "system"` 消息为单条前置（双换行拼接） |
| `extractThinkTags` | ✅ | **响应侧**：把 chat completion `content` 里的 inline `<think>...</think>` 块切出来，并入 `reasoning_content`。不开启 Codex 会把 `<think>...</think>` 当作正常 assistant 文本直接显示 |
| `dropStreamOptions` | ❌ | 整个 `stream_options` 字段。⚠️ 删了上游不再回传 usage → admin DB token 统计 / 缓存命中柱状图变 0。**仅在上游真的因此 400** 时再单独勾选 |
| `dropParallelToolCalls` | ❌ | 整个 `parallel_tool_calls` 字段。OpenAI 标准字段；仅在上游明确报错时再单独勾选 |

## 验证

1. **webui 探测**：模型行点"探测"，期望 200 OK
2. **Codex 桌面端实测**：发起需要多轮工具调用的提示词，期望不再出现 `(2013)` 系列报错
3. **`--verbose` 检查发出的请求体**：`strict` / `content:null` / `tool_choice:"auto"` / `stream_options` / `parallel_tool_calls` 都不出现，`messages` 数组最多 1 条 `role: "system"` 在 `[0]`

## 报错对照表

| MiniMax 报错 | 命中的子开关 |
|---|---|
| `invalid chat setting (2013)` — strict 相关 | `dropNullStrict` |
| `invalid chat setting (2013)` — content 相关 | `dropNullContent` |
| `invalid chat setting (2013)` — tool_choice | `dropToolChoiceAuto` |
| `invalid chat setting (2013)` — stream_options/parallel_tool_calls | `dropStreamOptions` / `dropParallelToolCalls` |
| `invalid message role: system (2013)` | `mergeSystemMessages` |
| `unknown model 'xxx' (2013)` | 顶层 `forceDefaultModel` |

实际上以上全部开关一次性打开就是 `features.minimaxCompat: true`，没必要逐个调。

## 设计动机：为什么不全局修正？

这些字段在 OpenAI / MiMo / DeepSeek 上都合法且 mimo2codex 依赖部分字段：
- `stream_options.include_usage` 是 admin DB token 统计 + 缓存命中柱状图的来源
- 多条 system 消息在 Codex 协议里有合理用途（指令 + 权限 + model_switch）
- `tool_choice: "auto"` 显式传到 MiMo 与默认行为等价

如果在主线 `reqToChat` 里硬改，会破坏 MiMo/DeepSeek/Qwen/Kimi/GLM/Ollama 等已有 provider。所以 v0.2.8 起做成 **opt-in 后处理**：只有显式打开开关的 provider 才走过 sanitizer。
