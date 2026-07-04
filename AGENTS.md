# Agent instructions for the mimo2codex repo

This repo is a local proxy that lets the latest OpenAI Codex CLI / desktop talk
to **Xiaomi MiMo V2.5** and **DeepSeek V4 Pro** by translating the Responses
API to upstream Chat Completions. Routing is per-request: the client-supplied
`model` field decides which provider serves the request (see `src/providers/`
and `src/server.ts:selectProvider`). When you (the agent) run inside Codex
pointed at this proxy, the chat backend is **MiMo or DeepSeek, not OpenAI** —
adjust your assumptions accordingly.

## Hard rules

1. **Never `pip install openai` and never `import openai`.** This project
   intentionally avoids the OpenAI Python SDK. The user's API key is for
   Xiaomi MiMo, not OpenAI — `openai` SDK calls would either fail
   authentication or hit endpoints that don't exist. The sandbox also blocks
   network installs.

2. **Never assume image generation is available natively.** MiMo V2.5 does not
   have an image generation endpoint. Codex's `/hatch` (which calls OpenAI's
   `gpt-image-1`) does not work when Codex is pointed at MiMo. There is a
   ready-made workaround in `mimoskill/`; use that instead of writing fresh
   code to call `gpt-image-1`.

3. **Don't fight the sandbox by asking the user to install packages.** If you
   would normally write code that needs a Python dependency, first check
   `mimoskill/scripts/` — most things you need are already there using only
   stdlib (`urllib.request`, `json`, etc.). If you genuinely need a new
   dependency, say so explicitly with the user before adding code that
   depends on it.

4. **Non-vision model + image input → don't give up, OCR it.** When the
   active chat model is `mimo-v2.5-pro`, `deepseek-*`,
   or any third-party model without vision, the proxy strips image
   attachments in `src/translate/reqToChat.ts:48-72` and leaves a
   `[N image attachment(s) omitted: this model does not support image input …]`
   placeholder. When you see that placeholder, **or** when the user asks to
   "read / describe / OCR / 识别 / 提取" an image, run
   `python3 mimoskill/scripts/ocr.py <image>` and feed the result back into
   the conversation. The script always uses `mimo-v2.5` internally — do
   **not** ask the user to switch chat models, the OCR fallback is
   transparent.

## Where things are

- `src/` — TypeScript source for the proxy (Node 18+). Compiled to `dist/`
  via `npm run build`. Tests in `test/` (vitest, 45 files).
  - `providers/` — Provider abstraction (`types.ts`, `mimo.ts`, `deepseek.ts`,
    `registry.ts`). MiMo-specific behavior (web_search builtin, thinking
    injection, token-plan host inference) is confined to `mimo.ts` hooks; do
    NOT leak it to the generic translate/upstream layers.
  - `db/` — better-sqlite3 persistence (chat logs, model catalog, aliases,
    settings). Default at `~/.mimo2codex/data.db`. Disabled with `--no-admin`.
  - `admin/router.ts` — `/admin/api/*` REST + SPA hosting at `/admin/`.
  - `translate/`, `upstream/`, `util/` — generic, provider-agnostic.
- `web/` — Vite + React 18 admin console (separate workspace). Builds to
  `dist/web/`. Run `npm run web:install` once, then `npm run web:build` (or
  `npm run build:all` to do both backend + frontend). Dev: `npm run web:dev`
  on port 5173 with `/admin/api` proxied to 8788.
- `scripts/install.sh` and `scripts/install.ps1` — bootstrap scripts (clone or
  in-repo run, install deps, build, test).
- `mimoskill/` — a self-contained directory with helpers for MiMo + workarounds
  for what MiMo doesn't do. **This is where you should look first when the
  user asks for anything beyond plain chat.**

## Specifically: generating a Codex pet from an image

The user almost certainly hits this when they say "generate a pet" /
"`/hatch` doesn't work" / "the image generation tool isn't available". The
flow you should follow is **already implemented** — just invoke it, do not
rewrite it from scratch:

```bash
# 1. Generate the pet image. --provider auto picks the best available backend
#    given the env vars: gpt-image-1 if PET_OPENAI_API_KEY is set, otherwise
#    pollinations.ai (free, no key, no signup). With only MIMO_API_KEY,
#    auto = pollinations.
python3 mimoskill/scripts/generate_pet.py \
    --description "<short chibi pet description>" \
    --out /tmp/pet.png

# 2. Optional: bundle of three states (idle / working / done) from one call
python3 mimoskill/scripts/generate_pet.py \
    --description "<...>" \
    --bundle /tmp/my-pet/

# 3. Install into Codex's pet directory (probes macOS/Linux/Windows paths)
bash mimoskill/scripts/install_pet.sh /tmp/pet.png "<pet-name>"
# or for the bundle:
bash mimoskill/scripts/install_pet.sh --bundle /tmp/my-pet/ "<pet-name>"
```

If the sandbox blocks the network call (Pollinations / OpenAI / Replicate),
do NOT respond with "please install openai". The correct response is:

> "I can't reach the network from inside the sandbox. Please run the
> following in a regular terminal (outside Codex), then tell me when it's
> done and I'll continue:
>
>     python3 mimoskill/scripts/generate_pet.py --description "..." --out /tmp/pet.png
>     bash mimoskill/scripts/install_pet.sh /tmp/pet.png "<pet-name>"
>
> No `pip install` is needed — the script uses only the Python standard
> library."

## Other MiMo capability gaps

When the user asks for something MiMo doesn't natively support, the answer
is in `mimoskill/references/models.md`. Quick rules:

- **Image input (vision)** — only `mimo-v2.5` accepts it.
  `mimo-v2.5-pro` does NOT. mimo2codex auto-strips images on non-vision
  models. **If you need the image content anyway, run
  `mimoskill/scripts/ocr.py` to extract text / description via `mimo-v2.5`
  without changing the chat model.** Modes: `text` (default, verbatim OCR),
  `describe` (prose), `structured` (JSON regions), `markdown` (re-render).
- **Image generation** — none of MiMo's models do this. Use
  `mimoskill/scripts/generate_image.py` for general image gen (free
  Pollinations by default, or higher-quality `gpt-image-1` when
  `PET_OPENAI_API_KEY` is set), or `mimoskill/scripts/generate_pet.py` +
  `install_pet.sh` for Codex `/hatch` pets specifically.
- **TTS / ASR** — separate MiMo endpoints (`mimo-v2.5-tts`, `mimo-v2.5-asr`).
  Out of scope for the chat completions proxy; call them directly.
- **Code interpreter / sandboxed Python** — not provided by MiMo. Run code
  locally if needed.
- **`computer_use_preview` / `file_search`** — server-side OpenAI tools with
  no MiMo equivalent. mimo2codex silently drops them.

## Field quirks when calling MiMo directly

These bite people; use them when writing chat-completions calls:

- Use `max_completion_tokens`, NOT `max_tokens`.
- When you send `image_url` content, you MUST also send a `text` content part
  in the same array — image-only messages return 400 "Param Incorrect:
  `text` is not set". An empty space `" "` is enough.
- Reasoning is `reasoning_content` on the assistant message (DeepSeek-style),
  not `reasoning_summary`.
- Web search is a builtin tool of `type: "web_search"` — **not** a function
  tool. Requires the user to have activated the Web Search Plugin in their
  MiMo console (separately metered).
- `tool_choice` other than `"auto"` is silently ignored upstream right now.

For the canonical reference, hit
`https://platform.xiaomimimo.com/docs/api/chat/openai-api`.

## Change workflow rules

These apply to every change made in this repo, on top of the technical hard rules above:

1. **Never commit on the user's behalf.** Do not run `git commit`, `git add` with intent to commit, `git push`, `git tag`, or any release script (`npm run release:patch / release:minor / release:major / release:beta`). The user reviews the working tree and commits / publishes manually. Read-only inspection (`git status`, `git diff`, `git log`) and branch creation are fine; surface "what changed and where" at the end of the task and leave staging untouched.

2. **Log every non-trivial change in BOTH `tag-log` and `release-notes`.** A change worth a `[new]` / `[opt]` / `[fix]` / `[doc]` tag must land in both files — they're complementary, never update only one:
   - **`doc/tag-log.md` + `doc/tag-log.zh.md`** — developer-facing verbose changelog. Append under the current upcoming-version block, or create a new `## vX.Y.Z — YYYY-MM-DD` section at the top. Keep the bilingual files in lockstep.
   - **`web/src/release-notes.tsx`** — user-facing in-app "What's new" modal. Add a `ReleaseHighlight` to the matching `ReleaseNote`, or prepend a new entry when bumping the version. Each highlight needs bilingual `title` + `description` + a `kind` (`new`/`improved`/`fixed`/`doc`); add an optional `location` so users can find the new thing in the UI ("教学" part), and an optional `ctaLabel` + `ctaPath` (in-app route) / `ctaHref` (external link).

   The user bumps the version with `npm run release:*` themselves (see rule 1); the new modal pops on first admin load after the proxy restarts.

## When in doubt

- Read `README.md` (English) or `README.zh.md` (Chinese) for the proxy itself.
- Read `mimoskill/SKILL.md` for the MiMo helper library and pet workflow.
- Both `node dist/cli.js print-config` and `node dist/cli.js print-cc-switch`
  emit ready-to-paste config snippets — prefer those over hand-crafting
  TOML / JSON.
- If you find yourself writing a new `import openai` or `pip install
  openai` line, stop and use `mimoskill/scripts/mimo_chat.py` (chat),
  `mimoskill/scripts/ocr.py` (OCR / image recognition), or
  `mimoskill/scripts/generate_image.py` / `generate_pet.py` (image gen)
  instead.
