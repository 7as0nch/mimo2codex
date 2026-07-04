# MiMo V2.5 model capability matrix

Authoritative source: <https://platform.xiaomimimo.com/docs>. This file summarizes
the bits the skill cares about — read the official docs for full schemas.

## Models at a glance

| Model | Text | Vision | Audio in | Image gen | Audio gen | Reasoning | Context | Best for |
|---|---|---|---|---|---|---|---|---|
| `mimo-v2.5-pro` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ strong | 128K | Coding, agentic tasks, complex reasoning |
| `mimo-v2.5` | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ medium | 128K | Multimodal chat with image input |
| `mimo-v2.5-tts` | ❌ | ❌ | ❌ | ❌ | ✅ | – | – | TTS (separate endpoint) |
| `mimo-v2.5-asr` | ❌ | ❌ | ✅ | ❌ | ❌ | – | – | ASR (separate endpoint) |

> **Image generation is not in this table because no MiMo model produces images.**
> For image generation, see [pet_workflow.md](./pet_workflow.md) → "Image gen alternatives".

## Endpoints

| Capability | Endpoint | Compatible with |
|---|---|---|
| Chat (text + vision) | `https://api.xiaomimimo.com/v1/chat/completions` | OpenAI Python SDK / curl |
| Chat (Anthropic shape) | `https://api.xiaomimimo.com/anthropic/v1/messages` | Anthropic SDK / Claude Code |
| TTS | (consult MiMo TTS docs) | MiMo SDK |
| ASR | (consult MiMo ASR docs) | MiMo SDK |

Token Plan users substitute `https://token-plan-cn.xiaomimimo.com` for the host.

## Authentication

Both header forms are accepted:

```
Authorization: Bearer ${MIMO_API_KEY}
```

or

```
api-key: ${MIMO_API_KEY}
```

Key prefixes:

- `sk-...` — pay-as-you-go (uses default `api.xiaomimimo.com` base URL)
- `tp-...` — token plan subscription (uses `token-plan-cn.xiaomimimo.com` base URL)

## Field quirks (vs OpenAI)

These trip people up:

1. Use **`max_completion_tokens`**, not `max_tokens`. MiMo follows the newer spec.
2. **Reasoning is exposed as `reasoning_content`** on assistant messages (DeepSeek-style), not OpenAI's `reasoning_summary`.
3. For **multi-turn tool calls in thinking mode**, *re-inject all prior `reasoning_content`* on the next request — MiMo recommends this, drops in quality otherwise.
4. **Image input requires both `image_url` AND a `text` part**. An image-only message returns `400 Param Incorrect: text is not set`. Add a `{type: "text", text: " "}` part if you don't have a real prompt.
5. **`tool_choice` other than `"auto"`** is currently silently ignored upstream — behavior is always equivalent to `auto`.
6. **Web Search builtin** is a tool of `type: "web_search"` (not a function tool). Requires the [Web Search Plugin](https://platform.xiaomimimo.com/#/console/plugin) to be activated in your console first; separately metered.
7. Annotations come back on `message.annotations` as `{type: "url_citation", url, title, summary}`.

## Tools and function calling

Standard OpenAI function tool format works:

```json
{
  "type": "function",
  "function": {
    "name": "...",
    "description": "...",
    "parameters": { "type": "object", "properties": { ... } },
    "strict": false
  }
}
```

`tool_calls` come back on the assistant message; reply with `{role: "tool", tool_call_id, content}`. Parallel tool calls are supported.

## Web search

```json
{
  "type": "web_search",
  "max_keyword": 3,
  "force_search": true,
  "limit": 1,
  "user_location": {
    "type": "approximate",
    "country": "China",
    "region": "Hubei",
    "city": "Wuhan"
  }
}
```

Streaming: search sources arrive in the **first** SSE chunk's `delta.annotations`.

## Quick model picker

```
Need image input?            → mimo-v2.5
Doing heavy reasoning/code?  → mimo-v2.5-pro
Just doing cheap text chat?  → mimo-v2.5
Need TTS?                    → mimo-v2.5-tts (separate endpoint)
Need ASR?                    → mimo-v2.5-asr (separate endpoint)
Need image generation?       → MiMo can't. Use gpt-image-1 / Pollinations / SD.
```
