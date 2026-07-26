# Connecting MiniMax

> 中文版: [minimax.zh.md](./minimax.zh.md)

MiniMax (`https://api.minimax.io/v1` / `https://api.minimaxi.com/v1`) speaks the OpenAI Chat Completions wire format, but its request validation is stricter than OpenAI / MiMo / DeepSeek. Connecting it through mimo2codex's generic provider hits a handful of non-obvious 400s. This doc explains how the MiniMax compat switches (v0.2.8+) resolve them in one shot.

Source: [issue #7](https://github.com/7as0nch/mimo2codex/issues/7).

## Symptoms (before the fix)

Multi-turn tool calls fail with:
- `invalid chat setting (2013)`
- `invalid message role: system (2013)`
- `unknown model 'gpt-5.5' (2013)`

In the Codex desktop client the first turn may succeed; the second turn (function_call → function_call_output) blows up.

## Root cause

MiniMax is stricter than other OpenAI-compatible upstreams:

| Field | OpenAI / DeepSeek | MiMo | MiniMax |
|---|---|---|---|
| `tools[*].function.strict: null` | accept | **reject** (issue #11) | **reject** |
| assistant message `content: null` (with `tool_calls`) | accept | **reject** |
| `tool_choice: "auto"` (explicit) | accept | **reject** (require omitted) |
| `stream_options.include_usage` | accept | **reject** (non-standard) |
| `parallel_tool_calls` | accept | **reject** (non-standard) |
| Multiple `role: "system"` messages | accept | **reject** (only one, must be first) |

Codex also forwards the literal `model` from its config (e.g. `gpt-5.5`); MiniMax doesn't recognize it → 400.

**One more common surprise** — MiniMax wraps thinking inline as `<think>...</think>` *inside* the `content` field, whereas mimo2codex defaults to the DeepSeek/MiMo style (`reasoning_content` as a separate field). Without splitting, the Codex client would render `<think>...</think>` verbatim as plain assistant text. `features.extractThinkTags` (included in the `minimaxCompat` preset) extracts those blocks from content into reasoning_content, bringing parity with DeepSeek-R1's wire shape.

## Recommended setup (providers.json)

In `~/.mimo2codex/providers.json`:

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

The same preset also matches `https://api.minimaxi.com/v1`. `MiniMax-M3` is the 1,000,000-token default; keep `MiniMax-M2.7` if you still need the 204,800-token catalog entry.

Then:
```bash
export MINIMAX_API_KEY=<your_key>
mimo2codex --model minimax
```

Open the webui (`http://127.0.0.1:8788/admin/`) and click **Probe** on the MiniMax model row for one-click verification.

## Lite setup (env-var single-instance)

If MiniMax is the only upstream you need:

```bash
export GENERIC_BASE_URL=https://api.minimax.io/v1
export GENERIC_API_KEY=<your_key>
export GENERIC_DEFAULT_MODEL=MiniMax-M3
export GENERIC_FORCE_DEFAULT_MODEL=1   # key bit: unknown client models (e.g. "gpt-5.5") rewrite to MiniMax-M3
mimo2codex
```

⚠️ **The env-var path cannot carry `features.minimaxCompat`** — switch to providers.json if you need the strict-mode sanitizers.

Need the 204,800-token `MiniMax-M2.7` catalog entry instead? Use providers.json and set the model id there.

## Field reference

### Top-level

| Field | Default | Effect |
|---|---|---|
| `forceDefaultModel` | `false` | When `models: []`, make `resolveModel` return null so selectProvider's fallback rewrites the request model to this provider's `defaultModel`. Required for the MiniMax env-var single-instance flow. |

### `features.*` (MiniMax compat switches)

All default `false`. Setting `minimaxCompat: true` enables the five switches marked **✅** below. `dropStreamOptions` / `dropParallelToolCalls` are **not** in the preset — they're OpenAI standard fields MiniMax accepts, and `stream_options.include_usage` is the source of admin DB token statistics.

| Field | In preset | What it strips |
|---|---|---|
| `minimaxCompat` | — | **Preset** (enables the ✅ switches below) |
| `dropNullStrict` | ✅ | `tools[*].function.strict === null` (explicit `true`/`false` preserved) |
| `dropNullContent` | ✅ | assistant message `content === null` fields |
| `dropToolChoiceAuto` | ✅ | `tool_choice === "auto"` ("auto" is the default anyway) |
| `mergeSystemMessages` | ✅ | Merge all `role: "system"` messages into one leading entry (joined by `\n\n`) |
| `extractThinkTags` | ✅ | **Response side**: extract inline `<think>...</think>` blocks from `content` into `reasoning_content`. Without this Codex displays `<think>...</think>` verbatim as plain assistant text |
| `dropStreamOptions` | ❌ | Entire `stream_options` field. ⚠️ Upstream stops returning `usage` → admin DB token stats / cache-hit chart go to 0. **Enable only if upstream actually 400s on it** |
| `dropParallelToolCalls` | ❌ | Entire `parallel_tool_calls` field. OpenAI standard; enable only when upstream explicitly rejects it |

## Verification

1. **webui probe**: click "探测" on the model row, expect 200
2. **Codex desktop**: trigger a multi-turn tool-calling prompt; the `(2013)` errors should disappear
3. **`--verbose` request inspection**: `strict` / `content:null` / `tool_choice:"auto"` / `stream_options` / `parallel_tool_calls` are absent from the upstream POST body; `messages` contains at most one `role: "system"`, at index 0

## Error → switch cheat sheet

| MiniMax error | Switch to enable |
|---|---|
| `invalid chat setting (2013)` — strict related | `dropNullStrict` |
| `invalid chat setting (2013)` — content related | `dropNullContent` |
| `invalid chat setting (2013)` — tool_choice | `dropToolChoiceAuto` |
| `invalid chat setting (2013)` — stream_options/parallel_tool_calls | `dropStreamOptions` / `dropParallelToolCalls` |
| `invalid message role: system (2013)` | `mergeSystemMessages` |
| `unknown model 'xxx' (2013)` | top-level `forceDefaultModel` |

In practice just `features.minimaxCompat: true` flips all of them — no need to tune individually.

## Design note: why isn't this just done globally?

The stripped fields are all valid for OpenAI / MiMo / DeepSeek and several of them are *load-bearing* for mimo2codex:
- `stream_options.include_usage` feeds the admin DB's token accounting and the cache-hit chart
- Multiple system messages are how Codex carries instructions + permissions + model_switch
- `tool_choice: "auto"` is a no-op against MiMo

Patching `reqToChat` directly would silently change behavior for MiMo / DeepSeek / Qwen / Kimi / GLM / Ollama users. So as of v0.2.8 this is an **opt-in post-processor** — only providers that explicitly turn the switch on run through the sanitizer.
