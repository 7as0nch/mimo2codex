# OCR / image recognition workflow

`mimoskill/scripts/ocr.py` is the fallback path for reading or describing
images when the surrounding chat model can't see them. Three engines:

| Engine | Needs API key | Needs network | Quality | Notes |
|---|---|---|---|---|
| `mimo` | yes (`MIMO_API_KEY`) | yes | best | Calls `mimo-v2.5` regardless of the chat model used elsewhere. All modes supported. |
| `tesseract` | **no** | **no** | decent for clean print | Fully local. `--mode text` only. Recommended when network access to pollinations is unreliable (e.g. mainland China). Requires one-time install. |
| `pollinations` | **no** | yes | decent | Free public endpoint at `text.pollinations.ai`. All modes supported, but may be slow / unreachable behind some firewalls. |

`--engine auto` (default) picks in this order:
1. `mimo` if `MIMO_API_KEY` is set
2. `tesseract` if installed on PATH **and** `--mode text`
3. `pollinations` otherwise

So users with only a DeepSeek key, or no key at all, still get OCR — and
users behind GFW who have tesseract installed never need to touch the
network.

## TL;DR

```bash
# Zero-setup — uses free pollinations fallback when MIMO_API_KEY is unset
python3 mimoskill/scripts/ocr.py path/to/image.png
python3 mimoskill/scripts/ocr.py --mode describe path/to/image.png
python3 mimoskill/scripts/ocr.py --mode structured a.png b.jpg
python3 mimoskill/scripts/ocr.py --mode markdown form.png

# Force the free engine even when you have a MiMo key (e.g. to save quota)
python3 mimoskill/scripts/ocr.py --engine pollinations form.png

# Best quality — set MiMo key
export MIMO_API_KEY=sk-xxxxxxxxxxxxxxxx
python3 mimoskill/scripts/ocr.py path/to/image.png   # auto -> mimo
```

## Why this skill exists

The proxy strips image attachments when the active chat model can't accept
them (`src/translate/reqToChat.ts:48-72`). Non-vision MiMo variants —
`mimo-v2.5-pro` returns 404
"No endpoints found that support image input" if images are forwarded.
The proxy drops the images and leaves an `[N image attachment(s) omitted: …]`
placeholder so the conversation doesn't crash.

`ocr.py` is the recommended way to recover that content **without changing
the chat model**: it independently calls `mimo-v2.5`, returns text, and the
caller pipes that text back into the conversation as a normal user message.

## Input modes

The positional `IMAGE` args (0 or more) accept:

| Form | Example | What ocr.py does |
|---|---|---|
| Local path | `./scan.png`, `C:\foo.jpg` | reads bytes, magic-byte sniffs MIME, base64-encodes to a `data:` URL |
| `http(s)://` URL | `https://example.com/x.png` | forwarded as-is; MiMo fetches server-side |
| `data:` URL | `data:image/png;base64,…` | forwarded as-is |
| `-` (single dash) | piped from stdin | reads one image's bytes from stdin |
| nothing + non-TTY stdin | `cat x.png \| ocr.py` | same as `-` |

Magic-byte table (file extension is **not** trusted):

| Bytes | MIME |
|---|---|
| `89 50 4E 47 0D 0A 1A 0A` | `image/png` |
| `FF D8 FF` | `image/jpeg` |
| `47 49 46 38 37 61` / `…39 61` | `image/gif` |
| `52 49 46 46 …. 57 45 42 50` | `image/webp` |
| `42 4D` | `image/bmp` |
| (anything else) | falls back to `image/png` |

## Output modes (`--mode`)

### `text` (default) — verbatim OCR

```bash
python3 mimoskill/scripts/ocr.py invoice.png
```

Stdout is the raw extracted text. Line breaks, reading order, and rough
column/table layout (whitespace + pipes) are preserved. No commentary, no
translation, no summary. Unreadable spans become `[unreadable]`. Image with
no text returns the single line `[no text detected]`.

### `describe` — short prose description

```bash
python3 mimoskill/scripts/ocr.py --mode describe screenshot.png
```

2-4 sentences covering layout, key elements, visible text (quoted), and
notable colors. No invented details.

### `structured` — JSON

```bash
python3 mimoskill/scripts/ocr.py --mode structured form.png
```

Stdout is a single JSON object:

```json
{
  "text": "...",
  "language": "zh-Hans",
  "regions": [
    {"label": "title", "text": "增值税电子发票", "role": "title"},
    {"label": "buyer", "text": "...", "role": "paragraph"},
    {"label": "items", "text": "...", "role": "table"}
  ],
  "summary": "A Chinese VAT e-invoice with buyer/seller and four line items."
}
```

`regions[].role` is one of `title`, `paragraph`, `list`, `table`, `caption`,
`ui`, `handwriting`, `other`.

**Note**: `structured` returns **logical regions** (role classification),
not pixel bounding boxes. MiMo does not currently expose grounded pixel
coordinates the way some other vision models do; this skill won't pretend
to. If you need pixel boxes, use a model that does (e.g. Gemini grounding,
Tesseract with `--psm 6` + position data).

### `markdown` — re-render as GFM

```bash
python3 mimoskill/scripts/ocr.py --mode markdown spec.png
```

Headings become `#`/`##`, tables become pipe tables, code-like text becomes
fenced blocks, lists become `-`. Reading order preserved. Output is the
Markdown body only — no preamble, no outer fence.

## Batch (multi-image) calls

Pass multiple positional args:

```bash
python3 mimoskill/scripts/ocr.py page1.png page2.png page3.png
```

All images go to MiMo in a **single** chat completion (one billable call).
The model can cross-reference (e.g. ID front + back). Output is a single
text body in reading order across the images.

When you need a different prompt per image, run `ocr.py` N times instead.

## `--lang` and `--prompt`

- `--lang LANG` appends `Primary language: <LANG>.` to the prompt. Useful
  for CJK to prevent the model from outputting Pinyin transliteration:
  `ocr.py --lang Chinese scan.png` or `--lang zh` or `--lang 日本語`.

- `--prompt EXTRA` appends a free-text instruction:
  `ocr.py --mode text --prompt "Only handwriting, ignore printed text." form.png`

## Model selection

| You pass | ocr.py uses |
|---|---|
| nothing | `$MIMO_OCR_MODEL` → `$MIMO_MODEL` (if vision-capable) → `mimo-v2.5` |
| `--model mimo-v2.5` | `mimo-v2.5` |
| `--model mimo-v2.5-pro` | **switches to `mimo-v2.5`** (stderr note) |
| `--model mimo-v2-omni` (retired) | **switches to `mimo-v2.5`** |
| `--model mimo-v2-flash` (retired) | **switches to `mimo-v2.5`** |

Non-vision models would return 404 from MiMo, so the script coerces them
silently (one stderr line) rather than failing.

## When `MIMO_API_KEY` isn't set

`--engine auto` (the default) chooses tesseract if it's installed and the
mode is `text`, otherwise pollinations:

```
# With tesseract installed
[engine] auto -> tesseract (local, no network). Set MIMO_API_KEY for higher quality (mimo-v2.5).
[ocr] engine=tesseract mode=text lang=eng+chi_sim images=1
<extracted text>

# Without tesseract
[engine] auto -> pollinations (free, no key).
  Set MIMO_API_KEY for higher quality (mimo-v2.5), or install tesseract for offline OCR.
[ocr] engine=pollinations mode=text model=openai images=1
<extracted text>
```

Exit code `3` is only raised when the user explicitly passes `--engine mimo`
without a key, or `--engine tesseract` without it installed (passing a flag
is treated as an assertion that engine should be used; auto-falling-back
would mask the misconfiguration).

## Tesseract specifics (offline / GFW-friendly path)

Install once, never touch the network again:

```bash
macOS:    brew install tesseract tesseract-lang
Ubuntu:   sudo apt install tesseract-ocr tesseract-ocr-chi-sim
Windows:  https://github.com/UB-Mannheim/tesseract/wiki
```

The script auto-detects tesseract on `PATH` via `shutil.which("tesseract")`.
Once installed, `python3 ocr.py <image>` (with `MIMO_API_KEY` unset) routes
through tesseract automatically.

**Language hints** — `--lang` is mapped to tesseract's `-l` codes:

| `--lang` | tesseract `-l` |
|---|---|
| `Chinese` (default for Chinese) | `chi_sim+chi_tra` |
| `zh` / `zh-hans` / `zh-cn` | `chi_sim` |
| `zh-hant` / `zh-tw` | `chi_tra` |
| `en` / `English` | `eng` |
| `ja` / `Japanese` / `日本語` | `jpn` |
| `ko` / `Korean` / `한국어` | `kor` |
| `fr` / `de` / `es` / `ru` | `fra` / `deu` / `spa` / `rus` |
| anything else | `eng+chi_sim` (sensible default for mixed CJK content) |
| raw tesseract code (e.g. `fra+ita`) | passed through |

If you need a language not pre-mapped, install the corresponding traineddata
on your system (e.g. `tesseract-ocr-deu` on Ubuntu, `brew install tesseract-lang`
on macOS) and pass `--lang` as the raw code.

**Limitations**: tesseract is an OCR engine, not an LLM — it only extracts
literal text. `--mode describe` / `structured` / `markdown` need a vision
LLM (mimo or pollinations) and will error if you force tesseract.

**Input forms**: all the usual ones work — local path, `http(s):` URL,
`data:` URL, stdin. URLs are downloaded to a temp file before tesseract
runs; data URLs are decoded; the temp file is cleaned up after.

## Pollinations specifics

- Endpoint: `https://text.pollinations.ai/openai` (OpenAI Chat Completions
  compatible).
- Default model: `openai` (vision-capable). Override with
  `--pollinations-model <name>` or `POLLINATIONS_MODEL=<name>`. Other
  vision-capable picks include `openai-large`, `openai-fast`.
- No `Authorization` header is sent; the service is open. Rate limits apply
  per-IP; if you hit them you'll see HTTP 429 in stderr — wait or retry.
- `reasoning_content` is normally empty for pollinations responses (the
  underlying models don't expose chain-of-thought).

## Common pitfalls

- **PDFs are not supported directly.** Rasterize first with one of:
  - `pdftoppm -png input.pdf out` (Poppler)
  - `mutool draw -o out-%d.png input.pdf` (MuPDF)
  - macOS: `sips -s format png input.pdf --out out.png`
- **Multi-image batches share one prompt.** If you need different modes /
  languages per image, invoke `ocr.py` once per image.
- **`structured` mode is logical regions, not pixel boxes.** See above.
- **`--stream` + `structured`**: the streamed body is still a single JSON
  object; buffer it before parsing.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Upstream HTTP error (MiMo or Pollinations; error body printed to stderr) |
| 2 | argv / usage error (no image, mutually exclusive flags, etc.) |
| 3 | `--engine mimo` requested without `MIMO_API_KEY`, or `--engine tesseract` requested but not installed |
| 4 | Local image file not found / unreadable |

## Composing with `mimo_chat.py`

OCR + downstream LLM call is a common pattern:

```bash
TEXT=$(python3 mimoskill/scripts/ocr.py invoice.png)
python3 mimoskill/scripts/mimo_chat.py "Summarize this invoice:\n$TEXT"
```

Or structured + parse:

```bash
JSON=$(python3 mimoskill/scripts/ocr.py --mode structured invoice.png)
echo "$JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary'])"
```
