# mimoskill · Detailed Guide

> English · [中文](./mimoskill.zh.md)
>
> Back to: [README English](../README.md) · [README 中文](../README.zh.md)

`mimoskill/` is a bundle of helper scripts + reference docs at the project root. It exists because some things MiMo / DeepSeek / most chat-only LLMs can't natively do (image generation, image understanding when the chat model is text-only, …), and Codex hardcodes a few capability assumptions on the client side that the proxy layer can't override.

The proxy and mimoskill are **completely independent**: mimoskill works without `mimo2codex` running, and mimo2codex works without mimoskill. They compose by **convention**: when the proxy detects a capability gap it leaves a placeholder text in the message that points the LLM at the right `mimoskill/scripts/*.py` script.

## When does it trigger?

> Short answer: **"the chat model does what it can; mimoskill fills the gap."**

| Capability | Chat model can do it | Chat model CAN'T do it |
|---|---|---|
| Read / OCR / 识图 an image | proxy forwards the image to the model directly; **mimoskill not triggered** | proxy strips the image and inserts `[N image attachment(s) omitted: … python3 mimoskill/scripts/ocr.py <path> …]`; the LLM reads that placeholder + AGENTS.md and **runs `ocr.py`** |
| Generate an image | no mainstream chat model has native image-gen | **mimoskill always triggers** — `scripts/generate_image.py` or `scripts/generate_pet.py` |
| Web search | proxy forwards Codex's `web_search` to MiMo's builtin on `sk-*` (pay-as-you-go) keys; auto-skipped on `tp-*` (token-plan) and DeepSeek | `scripts/mimo_chat.py` follows the same rule — auto-enables web search on MiMo `sk-*`, skips on `tp-*` / pollinations. No flag needed. |
| TTS / ASR | not exposed in Codex | `scripts/mimo_chat.py` direct call to MiMo's separate endpoints |

The triggering **happens in the LLM**, not in the proxy. The proxy only does protocol translation + minimal compatibility fixups (image stripping, placeholder injection). Codex reads [AGENTS.md](../AGENTS.md) and [mimoskill/SKILL.md](../mimoskill/SKILL.md), notices the placeholder or the user's intent, and decides which script to invoke. The script is an independent subprocess that **bypasses the proxy entirely** — OCR talks to MiMo or pollinations directly, image-gen talks to pollinations or OpenAI directly, etc.

## Layout

```
mimoskill/
├── SKILL.md                   # skill manifest the LLM reads — trigger rules, decision tree
├── scripts/
│   ├── mimo_chat.py           # direct chat / vision / web-search call to MiMo (stdlib-only)
│   ├── ocr.py                 # OCR / image recognition. Mimo or free pollinations
│   ├── generate_image.py      # general image generation (any style / subject)
│   ├── generate_pet.py        # Codex pet generation (chibi-sticker style)
│   └── install_pet.sh         # install generated PNG into Codex's pet directory
├── references/
│   ├── models.md              # MiMo capability matrix + field quirks
│   ├── ocr_workflow.md        # full OCR mode reference, exit codes, JSON shape
│   └── pet_workflow.md        # single-image vs animated bundle generation
└── assets/
    └── pet_prompt_template.md # tuned chibi-sticker prompt templates
```

## Scripts in depth

### `scripts/mimo_chat.py` — chat / vision (no key required)

Stdlib-only Python script for one-shot or streaming chat. Two engines, same `--engine auto|mimo|pollinations` pattern as `ocr.py`:

| Engine | Needs key | Notes |
|---|---|---|
| `mimo` | `MIMO_API_KEY` | Best quality. Web search auto-enabled on `sk-*` keys (no flag needed). TTS/ASR also MiMo-only. |
| `pollinations` | **NO** | Free public endpoint at `text.pollinations.ai`. Text + vision work. No web search / TTS / ASR. |

Auto resolution: `mimo` if `MIMO_API_KEY` set, else `pollinations`. So this script now works **without any key** for text and vision chat.

```bash
# Zero-setup — uses pollinations fallback
python3 mimoskill/scripts/mimo_chat.py "tell me a joke"
python3 mimoskill/scripts/mimo_chat.py --image https://x/y.png "describe this"

# Best quality + MiMo native features (web search auto-on with sk-*, TTS, ASR)
export MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx
python3 mimoskill/scripts/mimo_chat.py "今天上海天气"   # web_search auto-included
python3 mimoskill/scripts/mimo_chat.py --model mimo-v2.5-pro --max-tokens 8000 --stream "long answer please"
```

For the mimo engine, the script handles MiMo's quirks transparently: `max_completion_tokens` (not `max_tokens`), the required `text` part next to `image_url`, `reasoning_content` round-tripping for multi-turn, web search plugin invocation.

| Flag | Notes |
|---|---|
| `--engine` | `auto` / `mimo` / `pollinations` (default auto) |
| `--model` | default `mimo-v2.5-pro` (mimo engine). For vision use `mimo-v2.5` |
| `--pollinations-model` | default `openai` (vision-capable). Alternatives: `openai-large`, `openai-fast` |
| `--image URL` | attach image. Auto-bumps to vision-capable model |
| `--stream` | SSE streaming |
| `--max-tokens N` | maps to `max_completion_tokens` on mimo, `max_tokens` on pollinations |
| `--temperature F` | default 0.7 |

### `scripts/ocr.py` — OCR / image recognition

OCR fallback for when the chat model can't see images. **Three engines** (`--engine auto` picks):

| Engine | Needs key | Needs network | Modes | Notes |
|---|---|---|---|---|
| `mimo` | `MIMO_API_KEY` | yes | all | Calls `mimo-v2.5` (the vision model) regardless of the chat model in use. Best quality. |
| `tesseract` | **NO** | **NO** | text only | Fully local OCR. Recommended when pollinations is unreachable (e.g. mainland China). One-time install. |
| `pollinations` | **NO** | yes | all | Free public endpoint at `text.pollinations.ai`. No signup, but may be slow / blocked in some regions. |

Auto resolution order: `mimo` (if `MIMO_API_KEY`) → `tesseract` (if installed **and** `--mode text`) → `pollinations`. So users with **only a DeepSeek key** (or no key at all) still get OCR with zero setup; users behind GFW who install tesseract once never need to touch the network.

```bash
# Zero-setup — auto picks the best available engine
python3 mimoskill/scripts/ocr.py path/to/image.png

# Offline / behind GFW — install tesseract once, then it works without network
#   macOS:   brew install tesseract tesseract-lang
#   Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim
#   Windows: https://github.com/UB-Mannheim/tesseract/wiki
python3 mimoskill/scripts/ocr.py --engine tesseract --lang Chinese scan.png

# Best quality — set MiMo key
export MIMO_API_KEY=sk-xxxx
python3 mimoskill/scripts/ocr.py path/to/image.png   # auto -> mimo

# Force pollinations even when you have a MiMo key (save quota)
python3 mimoskill/scripts/ocr.py --engine pollinations form.png

# Force MiMo — errors out if MIMO_API_KEY is not set (no silent fallback)
python3 mimoskill/scripts/ocr.py --engine mimo form.png
```

Four output modes:

| `--mode` | Output |
|---|---|
| `text` (default) | verbatim OCR — line breaks + reading order preserved |
| `describe` | 2-4 sentence description |
| `structured` | single JSON object: `text` / `language` / `regions[]` / `summary` |
| `markdown` | re-render the image as GitHub-flavored Markdown |

Input forms (positional, 0+ args):
- Local path: `./scan.png`, `C:\foo.jpg`
- HTTP(S) URL: forwarded as-is
- `data:image/...;base64,…`: forwarded as-is
- `-` or piped stdin: read one image's bytes from stdin

Magic-byte MIME sniffing (not file extension): PNG / JPEG / GIF / WebP / BMP. Multi-image positional args batch into one upstream call.

> Full reference: [mimoskill/references/ocr_workflow.md](../mimoskill/references/ocr_workflow.md) (modes, exit codes, JSON shape, lang/prompt knobs, pollinations specifics).

### `scripts/generate_image.py` — general image generation

Thin wrapper over `generate_pet.py` minus the chibi-pet prompt boilerplate, with an optional `--style` for common looks. Same providers, same env vars, same auto-fallback strategy.

```bash
# Free — auto picks pollinations when no OpenAI key
python3 mimoskill/scripts/generate_image.py --prompt "japanese garden, watercolor, dawn" --out garden.png

# Best quality — set OpenAI key
export PET_OPENAI_API_KEY=sk-real-openai-key
python3 mimoskill/scripts/generate_image.py --prompt "..." --out art.png  # auto -> gpt-image-1

# Common style presets
python3 mimoskill/scripts/generate_image.py --style anime --prompt "shrine at dusk" --out shrine.png
```

| `--provider` | Backend |
|---|---|
| `auto` (default) | `gpt-image-1` if `PET_OPENAI_API_KEY` set, else `pollinations` |
| `pollinations` | Free, no key |
| `gpt-image-1` | OpenAI's official image gen — best quality |
| `replicate` | Replicate API (any model) |
| `local-sd` | Local Stable Diffusion |

> `PET_OPENAI_API_KEY` is intentionally **separate from `MIMO_API_KEY` and `OPENAI_API_KEY`** — it's used only for image generation, so leaking it (or just not having one) doesn't affect anything else.

### `scripts/generate_pet.py` — Codex pet generation

Same backends as `generate_image.py`, but with a tuned chibi-sticker prompt built around `--description`. Outputs a PNG sized + framed for Codex's pet picker.

```bash
# Single static pet (free)
python3 mimoskill/scripts/generate_pet.py --description "chibi shiba coder" --out pet.png

# Animated multi-state bundle (idle / thinking / typing / sleeping)
python3 mimoskill/scripts/generate_pet.py --description "chibi cat" --bundle ./shiba/
```

Prompt templates live in [mimoskill/assets/pet_prompt_template.md](../mimoskill/assets/pet_prompt_template.md). Full workflow in [mimoskill/references/pet_workflow.md](../mimoskill/references/pet_workflow.md).

### `scripts/install_pet.sh` — install pet into Codex

Probes macOS / Linux / Windows for the right pet directory and copies the PNG (or bundle) there. Works around Codex's hardcoded pet paths.

```bash
bash mimoskill/scripts/install_pet.sh pet.png shiba
# Then fully quit + relaunch Codex (system tray → Quit, not just close window)
```

## Three ways to use it

### 1. Direct invocation (any user, no setup)

```bash
python3 mimoskill/scripts/mimo_chat.py "..."
python3 mimoskill/scripts/ocr.py invoice.png        # works with no key, free pollinations
python3 mimoskill/scripts/generate_image.py --prompt "..."
```

No skill registration required — these are standard Python scripts (stdlib-only, no `pip install` step).

### 2. As a Claude Code skill

Symlink the directory into `~/.claude/skills/`:

```bash
ln -s "$(pwd)/mimoskill" ~/.claude/skills/mimoskill
```

Claude reads [SKILL.md](../mimoskill/SKILL.md) and automatically routes relevant requests ("generate a pet from this image", "read the text from this screenshot", "MiMo TTS this paragraph") to the right scripts.

### 3. As a Codex agent guide

Already wired via [AGENTS.md](../AGENTS.md) at the repo root. Codex reads it on each session and routes image-gen / pet / OCR tasks to mimoskill scripts — it **won't** try to `pip install openai` or call OpenAI's image_gen tool when the active backend is MiMo / DeepSeek / Qwen / any non-OpenAI provider.

## Environment variables

| Var | Used by | Notes |
|---|---|---|
| `MIMO_API_KEY` | `mimo_chat.py`, `ocr.py` (engine=mimo / auto when set) | MiMo Chat / vision key. **Optional** for both scripts — they fall back to free pollinations when unset |
| `MIMO_CHAT_ENGINE` | `mimo_chat.py` | `auto` / `mimo` / `pollinations` — same as `--engine` |
| `MIMO_BASE_URL` | `mimo_chat.py`, `ocr.py` | default `https://api.xiaomimimo.com/v1` |
| `MIMO_MODEL` / `MIMO_OCR_MODEL` | `ocr.py` model auto-pick | used when `--model` not passed and vision-capable |
| `MIMO_OCR_ENGINE` | `ocr.py` | `auto` / `mimo` / `pollinations` — same as `--engine` flag |
| `POLLINATIONS_MODEL` | `ocr.py` | default `openai` (vision-capable). Alternatives: `openai-large`, `openai-fast` |
| `PET_OPENAI_API_KEY` | `generate_pet.py`, `generate_image.py` | separate from `MIMO_API_KEY` / `OPENAI_API_KEY`; used only for image gen |
| `REPLICATE_API_TOKEN` | `generate_*.py --provider replicate` | required only when using Replicate backend |

## Common recipes

### Read text from an image, then summarize via the active chat model

```bash
TEXT=$(python3 mimoskill/scripts/ocr.py invoice.png)
python3 mimoskill/scripts/mimo_chat.py "Summarize this invoice:\n$TEXT"
```

Or inside Codex: just paste the image. The proxy strips it, leaves a placeholder pointing at `ocr.py`, Codex runs the script and feeds the text back into the conversation — no manual step.

### Generate a `/hatch` replacement pet (works without OpenAI key)

```bash
python3 mimoskill/scripts/generate_pet.py --description "chibi shiba coder" --out pet.png
bash mimoskill/scripts/install_pet.sh pet.png shiba
# Fully quit + relaunch Codex, pick the new pet from the picker
```

For higher quality, set `PET_OPENAI_API_KEY=sk-real-openai-key` and `auto` switches to `gpt-image-1`.

### Structured OCR + JSON parse

```bash
JSON=$(python3 mimoskill/scripts/ocr.py --mode structured invoice.png)
echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary'])"
```

### Multi-image batch OCR (one billable call)

```bash
python3 mimoskill/scripts/ocr.py page1.png page2.png page3.png
```

All images go in a **single** upstream call; the model can cross-reference (e.g. ID front + back). Output is a single text body in reading order across the images.

## Troubleshooting

<details>
<summary><b><code>MIMO_API_KEY</code> is not set</b> — ocr.py exits 3</summary>

You explicitly passed `--engine mimo`. Either drop the flag (`auto` will fall back to pollinations) or set the key:

```bash
export MIMO_API_KEY=sk-xxxx
python3 mimoskill/scripts/ocr.py form.png
```

</details>

<details>
<summary><b>Pollinations returns 429 / rate limit</b></summary>

You hit per-IP rate limits. Either wait + retry, or switch to `--engine mimo` if you have a MiMo key.

</details>

<details>
<summary><b>Codex shows <code>image_gen tool not available</code> when running /hatch</b></summary>

Codex's `/hatch` is hardcoded to call OpenAI's `image_gen` tool client-side. The proxy can't intercept that. Use `generate_pet.py` instead — see "Generate a /hatch replacement pet" above.

</details>

<details>
<summary><b><code>pip install openai</code> errors / Codex tries to install openai</b></summary>

That's Codex trying to fall back to the openai Python SDK for image generation. [AGENTS.md](../AGENTS.md) is wired to prevent this — make sure it's at the repo root and the Codex session has read it (start fresh session if you edited AGENTS.md mid-conversation).

</details>

<details>
<summary><b>Tool returned an image but my model can't see images in tool output</b></summary>

This is by design. Chat Completions `tool` role only accepts string content — image content parts in `function_call_output` are flattened to `[N image attachment(s) omitted from tool output: ...]` placeholders (see `toolOutputToString` in [src/translate/reqToChat.ts](../src/translate/reqToChat.ts)). To feed an image back to the LLM, have the tool save it to disk and return a file path, then re-attach as a user message — at which point the OCR fallback kicks in if the chat model is non-vision.

</details>

## Design notes

- **No `pip install` step.** Every script is stdlib-only. This avoids dependency drift and lets the scripts run on bare Python ≥ 3.8 anywhere.
- **Network operations are explicit.** No silent retries to alternate endpoints. If you ask for MiMo and there's no key, you get a clear error — not a silent fallback that masks the misconfiguration.
- **The proxy and mimoskill never call each other.** They're separate processes connected only by `AGENTS.md` / `SKILL.md` conventions. This makes both halves independently testable and replaceable.
- **Pollinations is the no-key escape hatch.** Used as the free fallback in `ocr.py` (vision), `generate_pet.py` (image gen), `generate_image.py` (image gen). Rate-limited but always available. The project treats it as a first-class option, not a degraded mode.
