---
name: mimoskill
description: Use Xiaomi MiMo V2.5 (the LLM behind mimo2codex) for chat, vision, web search, TTS and ASR — and route around capabilities MiMo doesn't natively support, especially OCR / image recognition / 识图 / 提取图片文字 / extract text from image when the current model can't see images, image generation / 图像生成 / 生成图片 / draw a picture / 画一张 including Codex Pets `/hatch`, and MiMo-backed computer-use setup. Trigger when the user mentions MiMo, calls into mimo2codex, asks to read text from an image, asks to describe or 识别 an image while using a non-vision model (mimo-v2.5-pro, mimo-v2-flash, …), asks to generate / hatch a Codex pet, asks for image generation while using MiMo as the chat backend, asks MiMo/Codex to operate/control the computer/desktop/app/window, or hits a "no image generation available" / "image_gen tool unavailable" / "this model does not support image input" message inside Codex.
---

# mimoskill — Xiaomi MiMo V2.5 + gap fillers

This skill bundles two things:

1. **Direct MiMo V2.5 access** — recipes for hitting `https://api.xiaomimimo.com/v1` for chat, vision, web search, TTS, and ASR (works whether or not the [mimo2codex](../README.md) proxy is running).
2. **Workarounds for MiMo's gaps** — concrete scripts for the few things MiMo doesn't do, particularly **image generation** (which is what Codex's `/hatch` pet creation needs).

## Hard rules (for Codex agents)

These are non-negotiable when operating inside Codex pointed at this proxy:

- **Never `pip install openai` and never `import openai`.** All scripts use only
  the Python standard library (`urllib.request`, `json`, etc.). The OpenAI SDK
  would fail auth or hit non-existent endpoints.
- **Never assume image generation is available natively.** MiMo has no image-gen
  endpoint. Use `scripts/generate_image.py` or `scripts/generate_pet.py`.
- **Don't fight the sandbox.** If you need a Python dependency, check
  `mimoskill/scripts/` first — most things are already there in stdlib.
- **Non-vision model + image input → OCR it.** When the chat model can't see
  images, run `scripts/ocr.py` — never ask the user to switch models.
- **Computer operation request → check the adapter first.** If the user asks
  MiMo/Codex to operate the desktop, run `scripts/computer_use_setup.py`. If it
  reports `adapter_missing`, briefly explain the third-party adapter that will
  be installed, then run `scripts/computer_use_setup.py --install` and surface
  progress. Do not silently skip setup and then attempt blind clicks.

## When to use

Trigger this skill when:

- User asks to hit MiMo's API directly (chat / vision / web search / TTS / ASR)
- User asks "how do I generate a Codex pet" / "/hatch isn't working" / "image_gen tool not available"
- User wants image generation as part of a MiMo-backed workflow
- User pastes the Codex error: `the image generation tool (image_gen) is not available in this environment` or `the CLI fallback requires the openai Python package`
- User wants to **OCR / read text from / describe / 识别 / 提取文字 from an image** while the active chat model is non-vision (e.g. mimo-v2.5-pro, mimo-v2-flash, deepseek-*, or any third-party text-only model) — use `scripts/ocr.py`. Works with or without a MiMo key (free pollinations fallback when `MIMO_API_KEY` is unset).
- User wants to **operate / control / click / type on the computer or desktop** through MiMo/Codex — use `scripts/computer_use_setup.py` first. If the adapter is missing, tell the user what will be installed and run `scripts/computer_use_setup.py --install`; after setup, continue with the `mimo-computer-use` MCP tools.
- User sees the proxy's `[N image attachment(s) omitted: this model does not support image input …]` placeholder in their transcript
- Anything in the `mimo2codex` repo that touches a feature MiMo doesn't support

## What MiMo V2.5 does and doesn't do

Quick answer:

| Capability | MiMo native | Best model | Notes |
|---|---|---|---|
| Text chat | ✅ | `mimo-v2.5-pro` | reasoning + tools |
| Tool / function calling | ✅ | any | parallel calls supported |
| Vision (image input) | ✅ | `mimo-v2.5` or `mimo-v2-omni` | NOT mimo-v2.5-pro |
| Web search | ✅ | any | requires Web Search Plugin activated in MiMo console |
| TTS (speech synth) | ✅ | `mimo-v2.5-tts` | separate endpoint |
| ASR (speech recog) | ✅ | `mimo-v2.5-asr` | separate endpoint |
| Audio chat | ✅ | `mimo-v2-omni` | input only |
| Video understanding | ✅ | `mimo-v2-omni` | input only |
| **Image generation** | ❌ | — | `scripts/generate_image.py` (general) or `scripts/generate_pet.py` (Codex pets) — see below |
| OCR / 识图 (when chat model is non-vision) | ⚠️ via `mimo-v2.5` or free pollinations | `scripts/ocr.py` | `--engine auto`: mimo if `MIMO_API_KEY` set, else pollinations (no key) |
| Code interpreter / sandbox | ❌ | — | not provided |
| Computer use / desktop control | ⚠️ via local MCP plugin | `mimo-computer-use` | Requires the local Trope CUA adapter (macOS + Windows) |

For the full capability matrix and examples, read [references/models.md](references/models.md).

## Decision tree: what does the user actually want?

```
Is it OCR / read text from image / describe / 识别 an image
when the active chat model is non-vision?
├── Yes → use scripts/ocr.py (mimo-v2.5 if MIMO_API_KEY set, else free pollinations)
└── No
    │
    Is it chat / vision / search / TTS / ASR with a vision-capable model?
    ├── Yes → use MiMo directly (see "Calling MiMo directly" below) or via mimo2codex if Codex is the client
    └── No
        │
        Do they want to operate/control the computer?
        ├── Yes → run scripts/computer_use_setup.py, install adapter if missing, then use mimo-computer-use MCP tools
        └── No, they want image generation
        │
        Is it for a Codex pet (`/hatch`)?
        ├── Yes → see "Generating a Codex pet" below (scripts/generate_pet.py + install_pet.sh)
        └── No  → see "General (non-pet) image generation" below (scripts/generate_image.py)
```

## Computer use / desktop control setup

When the user asks MiMo/Codex to operate the desktop, first diagnose the local
adapter:

```bash
python3 mimoskill/scripts/computer_use_setup.py
```

If the JSON says `adapter_missing`, tell the user exactly what will happen, then
start the installer and relay progress:

```bash
python3 mimoskill/scripts/computer_use_setup.py --install
```

Current installer behavior:

- macOS and Windows only: `git clone`s [Trope CUA](https://github.com/voctory/trope-cua)
  into `~/.mimo2codex/adapters/trope-cua` and runs its platform build script
  (`install-macos.sh` / `install-windows.ps1 -SelfContained`), then verifies the
  `trope-cua` command is on PATH. Needs `git` plus Xcode Command Line Tools (macOS)
  or the .NET SDK (Windows). Grant Accessibility + Screen Recording on macOS first run.

If Codex sandbox/network policy blocks the install command, ask for permission
to rerun outside the sandbox. Do not tell the user to install Python packages by
hand — point them at the Trope CUA install docs instead.

After setup, continue with the local MCP tools exposed by
`plugins/mimo-computer-use`: `computer_state`, `computer_click`,
`computer_type`, `computer_key`, `computer_scroll`, `computer_wait`, and
`computer_install_adapter`.

## Calling chat directly (works without any key)

Use `scripts/mimo_chat.py` for one-shot or streaming chat. Two engines, `--engine auto` (default) picks `mimo` if `MIMO_API_KEY` is set, else `pollinations` (free, no key) — so **the script works without any key** for text and vision.

```bash
# Zero-setup — uses pollinations fallback when MIMO_API_KEY is unset
python3 mimoskill/scripts/mimo_chat.py "your prompt here"
python3 mimoskill/scripts/mimo_chat.py --image https://example.com/x.png "describe this"

# Best quality + MiMo-specific features (web search, TTS, ASR)
export MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx
python3 mimoskill/scripts/mimo_chat.py "your prompt here"
python3 mimoskill/scripts/mimo_chat.py "今天上海天气?"   # web search auto-enabled on sk-* keys
python3 mimoskill/scripts/mimo_chat.py --stream "tell me a story"
```

When the mimo engine is active the script handles all MiMo-specific quirks — `max_completion_tokens` instead of `max_tokens`, the required `text` part next to `image_url`, `reasoning_content` round-tripping, etc. **Web search is auto-enabled on pay-as-you-go (`sk-*`) keys** — the `web_search` builtin is always included in the tools array and the model decides when to invoke it (`tool_choice: "auto"`). Token-plan (`tp-*`) keys skip web search (the endpoint doesn't support it). The pollinations engine doesn't support web search, TTS, or ASR (those are MiMo native features); it auto-switches to OpenAI-compat field names (`max_tokens`).

For non-trivial integrations, [references/models.md](references/models.md) and [the official MiMo OpenAI-compat doc](https://platform.xiaomimimo.com/docs/api/chat/openai-api) are the authoritative references.

## OCR / image recognition (when the chat model can't see images)

If the user wants to **read text from an image** or **describe / 识别 an image** but the current chat model is non-vision (`mimo-v2.5-pro`, `mimo-v2-flash`, `deepseek-*`, or any third-party text-only model), invoke `scripts/ocr.py`. Three engines, `--engine auto` (default) picks in this order — mimo if `MIMO_API_KEY` set, else tesseract if installed and mode=text, else pollinations:

- **`mimo`** — needs `MIMO_API_KEY`, uses `mimo-v2.5` regardless of the chat model. Best quality. All modes.
- **`tesseract`** — **no key, no network**. Fully local OCR. Auto-used if installed and `--mode text`. Recommended for users behind GFW or offline. One-time install: `brew install tesseract tesseract-lang` / `sudo apt install tesseract-ocr tesseract-ocr-chi-sim` / Windows installer at github.com/UB-Mannheim/tesseract/wiki.
- **`pollinations`** — free public vision endpoint at `text.pollinations.ai`, **no key required**. All modes. But may be unreachable from mainland China — if you see "connection failed (pollinations)", suggest tesseract as the offline alternative.

The proxy silently drops image attachments on non-vision models (`src/translate/reqToChat.ts:48-72`) and leaves a `[N image attachment(s) omitted: …]` placeholder. **When you see that placeholder in the transcript, the right move is to run ocr.py and feed the text back into the conversation.** Don't ask the user to switch models.

```bash
# Zero-setup — uses pollinations fallback when MIMO_API_KEY is unset
python3 mimoskill/scripts/ocr.py path/to/image.png
python3 mimoskill/scripts/ocr.py --mode describe https://example.com/x.png
python3 mimoskill/scripts/ocr.py --mode structured a.png b.jpg
cat scan.png | python3 mimoskill/scripts/ocr.py --mode markdown

# Best quality — set MiMo key, auto picks mimo
export MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx
python3 mimoskill/scripts/ocr.py path/to/image.png

# Force the free engine even when you have a MiMo key (e.g. to save quota)
python3 mimoskill/scripts/ocr.py --engine pollinations form.png
```

`ocr.py` accepts local paths, http(s) URLs, `data:` URLs, or stdin bytes. Magic-byte sniffs the MIME (PNG / JPEG / GIF / WebP / BMP). Multiple positional args are batched into one upstream call. Non-vision `--model` values are auto-coerced to `mimo-v2.5` with one stderr note (mimo engine only; on pollinations use `--pollinations-model`).

See [references/ocr_workflow.md](references/ocr_workflow.md) for full mode reference, exit codes, JSON shape for `--mode structured`, and the `--lang` / `--prompt` knobs.

## General (non-pet) image generation

For arbitrary image generation, use `scripts/generate_image.py` — a thin wrapper over `generate_pet.py` with the chibi-pet prompt boilerplate removed and an optional `--style` for common looks. Same providers (`auto` / `pollinations` / `gpt-image-1` / `replicate` / `local-sd`), same env vars, same `auto` fallback to free Pollinations when you only have a MiMo key.

```bash
# free, no key
python3 mimoskill/scripts/generate_image.py \
    --prompt "isometric cyberpunk city at dusk" --out /tmp/out.png

# with a style preset
python3 mimoskill/scripts/generate_image.py --style pixel-art \
    --prompt "a brave knight" --out /tmp/knight.png

# multiple variants -> /tmp/img-1.png /tmp/img-2.png /tmp/img-3.png /tmp/img-4.png
python3 mimoskill/scripts/generate_image.py --n 4 \
    --prompt "watercolor desert sunrise" --out /tmp/img.png

# best quality (needs PET_OPENAI_API_KEY — same env var as the pet flow)
export PET_OPENAI_API_KEY=sk-real-openai-key
python3 mimoskill/scripts/generate_image.py --provider gpt-image-1 \
    --prompt "..." --out /tmp/out.png
```

`--style` choices: `plain` (default, no prefix), `pixel-art`, `photo`, `3d-render`, `line-art`, `watercolor`, `sticker`. `plain` sends your prompt verbatim — pick that when the user gave a fully-specified prompt.

For **Codex `/hatch` pets** keep using `generate_pet.py` + `install_pet.sh` — that flow is unchanged and tuned for the chibi sprite + 3-state bundle Codex wants.

## Generating a Codex pet (the `/hatch` alternative)

**Why this needs special handling**: Codex's built-in `/hatch` pet generation requires OpenAI's image generation API (`gpt-image-1`). MiMo doesn't have an image generation endpoint, and mimo2codex can't fake one. So `/hatch` from inside Codex won't work when Codex is pointed at MiMo.

**The workaround**: generate the pet image *outside* of Codex, then drop the result into Codex's pet directory and restart Codex. The script supports several image-gen backends:

- **`auto` (default)** — picks `gpt-image-1` if you have an OpenAI key set, otherwise falls back to **pollinations.ai** (free, no key, no signup). **Works with only a MiMo key.**
- **`pollinations`** — free, no key required
- **`gpt-image-1`** — best quality, needs a real OpenAI key (separate from `MIMO_API_KEY`)
- **`replicate`** — FLUX/SDXL, ~$0.003/img, needs `REPLICATE_API_TOKEN`
- **`local-sd`** — Automatic1111/ComfyUI on `127.0.0.1:7860`, free, needs local setup

### Quickstart (only MiMo key required)

```bash
# 1. No OpenAI key, no pip install — just run with the free fallback
python3 mimoskill/scripts/generate_pet.py \
    --description "a chubby cyberpunk axolotl coding hero" \
    --out ~/Downloads/my-pet.png

# 2. Install into Codex's pet folder
bash mimoskill/scripts/install_pet.sh ~/Downloads/my-pet.png "axolotl-coder"

# 3. Restart Codex completely and select the new pet from the pet menu
```

### If the sandbox blocks the network call

Codex's sandbox may prevent the scripts from reaching external APIs
(Pollinations, OpenAI, Replicate, MiMo, etc.). When that happens, do **not**
respond with "please install openai" or try to work around the sandbox.
Tell the user to run the command in a regular terminal:

> I can't reach the network from inside the sandbox. Please run the
> following in a regular terminal (outside Codex), then tell me when it's
> done and I'll continue:
>
>     python3 mimoskill/scripts/generate_pet.py --description "..." --out /tmp/pet.png
>     bash mimoskill/scripts/install_pet.sh /tmp/pet.png "<pet-name>"
>
> No `pip install` is needed — the script uses only the Python standard
> library.

The same pattern applies for `generate_image.py`, `ocr.py`, and `mimo_chat.py`.

`generate_pet.py` will print `[provider] auto → pollinations` so you know the free path is in use.

### Optional: better quality with an OpenAI key

If you do want gpt-image-1 quality (and image-to-image edit via `--reference`):

```bash
export PET_OPENAI_API_KEY=sk-real-openai-key  # NOT mimo2codex-local
python3 mimoskill/scripts/generate_pet.py \
    --reference path/to/source-image.jpg \
    --description "a chubby cyberpunk axolotl coding hero" \
    --out ~/Downloads/my-pet.png
```

`auto` will pick gpt-image-1 automatically when this env var is set. This OpenAI key is **only** used for the image generation call — your chat conversations still go through MiMo via mimo2codex.

### Step-by-step walkthrough + prompt design

Read [references/pet_workflow.md](references/pet_workflow.md) for:

- The exact Codex pet folder location on macOS / Linux / Windows
- How to make a static image work (most pets are animated GIFs, but a static PNG fallback works)
- How to generate animated states (idle / working / done) — typically requires multiple gpt-image-1 calls with edit / remix prompting
- How to mix MiMo + image gen: have MiMo write the prompt, then feed that prompt to gpt-image-1

Use the proven pet prompt formula in [assets/pet_prompt_template.md](assets/pet_prompt_template.md) — it's tuned for the chibi / sticker style Codex uses.

## Image generation in general

If the user wants image generation for some other reason (not a pet), the same workaround applies: `gpt-image-1` is the highest-quality option but requires a real OpenAI key. Free alternatives:

- **Stable Diffusion** locally via [Automatic1111](https://github.com/AUTOMATIC1111/stable-diffusion-webui) or [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — heavy setup but no per-call cost
- **Together AI** / **Replicate** — pay-as-you-go for SDXL / FLUX
- **Pollinations.ai** — free, no key required, lower quality

`scripts/generate_pet.py` defaults to gpt-image-1 but accepts `--provider pollinations` for the free path (with reduced quality).

## Cost notes

- Direct MiMo: pay-as-you-go (`sk-xxx`) or token plan (`tp-xxx`). See [pricing](https://platform.xiaomimimo.com/docs/pricing).
- Web Search plugin: separately metered per keyword search. Cap with `max_keyword`.
- gpt-image-1: ~$0.04 per 1024×1024 image (low quality), up to ~$0.17 (HD). One pet usually costs <$0.50 even with retries.
- Pollinations.ai: free.

## Don't use this skill for

- Just running mimo2codex (that's an HTTP proxy; this skill is direct API + workarounds). For mimo2codex itself, see the project [README.md](../README.md) / [README.zh.md](../README.zh.md).
- Configuring Codex (use `mimo2codex print-config` or `mimo2codex print-cc-switch`).
- Anything Anthropic / Claude — this is MiMo-specific.
