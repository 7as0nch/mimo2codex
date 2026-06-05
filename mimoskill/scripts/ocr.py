#!/usr/bin/env python3
"""
ocr.py — OCR / image recognition that works without any API key.

Use this when the surrounding chat model can't see images (mimo-v2.5-pro,
mimo-v2-flash, deepseek-*, or any text-only model).

Engines (--engine):
  auto          (default) — mimo if MIMO_API_KEY set, else tesseract if
                 installed and --mode=text, else pollinations
  mimo          — Xiaomi MiMo V2.5 vision. Highest quality. Needs MIMO_API_KEY
  tesseract     — Local Tesseract OCR. NO KEY, NO NETWORK. Good for users
                 behind firewalls (e.g. mainland China where pollinations.ai
                 can be unreachable). Supports --mode text only.
  pollinations  — pollinations.ai free public vision endpoint. No key but
                 needs network reachable from the user (may be slow/unreliable
                 in some regions).

Modes (--mode):
  text       (default) verbatim OCR — raw text, preserves line breaks
  describe   2-4 sentence description of the image (mimo / pollinations only)
  structured single JSON object with text / language / regions / summary
             (mimo / pollinations only)
  markdown   re-render the image as GitHub-flavored Markdown
             (mimo / pollinations only)

Image inputs (positional, 0+):
  /path/to/file.png          local file → base64 data URL
  https://example.com/x.png  http(s) URL → forwarded as-is
  data:image/...;base64,...  data URL → forwarded as-is
  -                          read one image from stdin (bytes)
  (none, stdin not a TTY)    same as `-`

Usage:
    # Zero-setup
    python3 ocr.py path/to/image.png
    python3 ocr.py --mode describe https://example.com/x.png

    # Behind GFW / offline — install tesseract once, never need network again
    #   macOS:   brew install tesseract tesseract-lang
    #   Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim
    #   Windows: https://github.com/UB-Mannheim/tesseract/wiki
    python3 ocr.py --engine tesseract --lang Chinese scan.png

    # Best quality (needs MiMo key)
    export MIMO_API_KEY=sk-xxxx
    python3 ocr.py --mode structured a.png b.jpg

Only depends on the standard library — no `openai` SDK install needed.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


# --- modes ------------------------------------------------------------------

MODE_PROMPTS: dict[str, str] = {
    "text": (
        "Extract ALL legible text from the attached image(s) verbatim, "
        "preserving line breaks, reading order, and any obvious column/table "
        "layout using whitespace and pipes. Do not paraphrase, translate, "
        "summarize, or add commentary. If you cannot read part of it, output "
        "`[unreadable]` in place. If the image contains no text, output "
        "exactly the single line `[no text detected]`."
    ),
    "describe": (
        "Describe the contents of the attached image(s) in 2-4 sentences. "
        "Mention layout, key visual elements, any visible text (quoted), and "
        "notable colors. Do not invent details that aren't visible."
    ),
    "structured": (
        "Return ONE JSON object with keys `text` (string, full OCR — same "
        "rules as verbatim text extraction, preserve line breaks and reading "
        "order), `language` (BCP-47 best-guess like \"zh-Hans\" or \"en\"), "
        "`regions` (array of `{label, text, role}` where role is one of "
        "`title`, `paragraph`, `list`, `table`, `caption`, `ui`, "
        "`handwriting`, `other`), and `summary` (1-sentence description). "
        "Output ONLY the JSON, no markdown fences, no preamble."
    ),
    "markdown": (
        "Re-render the attached image(s) as GitHub-flavored Markdown. "
        "Headings become `#`/`##`, tables become pipe tables, code-like text "
        "becomes fenced code blocks, lists become `-`. Preserve reading "
        "order. Output ONLY the markdown body — no preamble, no fences "
        "wrapping the whole thing."
    ),
}

STRUCTURED_SYSTEM = (
    "You are an OCR engine. Output strictly machine-parseable JSON, "
    "no markdown fences, no commentary."
)


# --- MIME sniffing ----------------------------------------------------------

_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
]


def sniff_mime(data: bytes, hint_name: str | None = None) -> str:
    for sig, mime in _MAGIC:
        if data.startswith(sig):
            return mime
    # WebP: "RIFF....WEBP"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if hint_name:
        guessed, _ = mimetypes.guess_type(hint_name)
        if guessed and guessed.startswith("image/"):
            return guessed
    return "image/png"


def bytes_to_data_url(data: bytes, hint_name: str | None = None) -> str:
    mime = sniff_mime(data, hint_name)
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def resolve_image_arg(arg: str) -> str:
    """Turn a positional IMAGE arg into a URL suitable for image_url."""
    if arg == "-":
        if sys.stdin.isatty():
            sys.stderr.write("error: `-` requested but stdin is a TTY\n")
            sys.exit(2)
        data = sys.stdin.buffer.read()
        if not data:
            sys.stderr.write("error: stdin was empty\n")
            sys.exit(2)
        return bytes_to_data_url(data)
    if arg.startswith(("http://", "https://", "data:")):
        return arg
    path = Path(arg)
    if not path.exists():
        sys.stderr.write(f"error: image not found: {arg}\n")
        sys.exit(4)
    try:
        data = path.read_bytes()
    except OSError as e:
        sys.stderr.write(f"error: cannot read {arg}: {e}\n")
        sys.exit(4)
    return bytes_to_data_url(data, hint_name=path.name)


# --- model auto-select ------------------------------------------------------

def model_supports_images(model: str) -> bool:
    """Mirror src/translate/reqToChat.ts:modelSupportsImages."""
    base = model.split("[", 1)[0].lower()
    if "omni" in base:
        return True
    if base == "mimo-v2.5":
        return True
    return False


def pick_model(cli_model: str | None) -> tuple[str, str | None]:
    """Returns (chosen_model, note_for_stderr_or_None)."""
    if cli_model:
        if model_supports_images(cli_model):
            return cli_model, None
        return "mimo-v2.5", (
            f"note: model '{cli_model}' does not see images; "
            f"switching to mimo-v2.5 for this call.\n"
        )
    env_ocr = os.environ.get("MIMO_OCR_MODEL")
    if env_ocr and model_supports_images(env_ocr):
        return env_ocr, None
    env_chat = os.environ.get("MIMO_MODEL")
    if env_chat and model_supports_images(env_chat):
        return env_chat, None
    return "mimo-v2.5", None


# --- message building -------------------------------------------------------

def build_messages(
    *, mode: str, image_urls: list[str], lang: str | None, extra_prompt: str | None
) -> list[dict[str, Any]]:
    user_text = MODE_PROMPTS[mode]
    if lang:
        user_text += f" Primary language: {lang}."
    if extra_prompt:
        user_text += f" {extra_prompt}"

    content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": u}} for u in image_urls
    ]
    content.append({"type": "text", "text": user_text})

    messages: list[dict[str, Any]] = []
    if mode == "structured":
        messages.append({"role": "system", "content": STRUCTURED_SYSTEM})
    messages.append({"role": "user", "content": content})
    return messages


# --- Tesseract (local, offline) ---------------------------------------------

# Lightweight mapping from human/--lang hints to tesseract trained-data codes.
# Tesseract supports compound languages via "+": "eng+chi_sim+chi_tra".
_TESSERACT_LANG_MAP: dict[str, str] = {
    "chinese": "chi_sim+chi_tra",
    "zh": "chi_sim",
    "zh-hans": "chi_sim",
    "zh-cn": "chi_sim",
    "zh-hant": "chi_tra",
    "zh-tw": "chi_tra",
    "english": "eng",
    "en": "eng",
    "japanese": "jpn",
    "ja": "jpn",
    "日本語": "jpn",
    "korean": "kor",
    "ko": "kor",
    "한국어": "kor",
    "french": "fra",
    "fr": "fra",
    "german": "deu",
    "de": "deu",
    "spanish": "spa",
    "es": "spa",
    "russian": "rus",
    "ru": "rus",
}


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def map_lang_to_tesseract(lang: str | None) -> str:
    """Resolve --lang hint to a tesseract -l string. Default: eng+chi_sim."""
    if not lang:
        return "eng+chi_sim"
    key = lang.strip().lower()
    if key in _TESSERACT_LANG_MAP:
        return _TESSERACT_LANG_MAP[key]
    # If the user passed a raw tesseract code (e.g. "fra+ita") we trust it.
    if all(part.isalnum() or part == "_" for part in key.replace("+", "_")):
        return lang
    return "eng+chi_sim"


def resolve_to_local_file(image_arg: str) -> tuple[Path, bool]:
    """Resolve a positional IMAGE arg to a path tesseract can read.
    Returns (path, is_temp). Caller should delete the file if is_temp."""
    if image_arg == "-":
        if sys.stdin.isatty():
            sys.stderr.write("error: `-` requested but stdin is a TTY\n")
            sys.exit(2)
        data = sys.stdin.buffer.read()
        return _write_temp_image(data, hint_name=None)
    if image_arg.startswith(("http://", "https://")):
        try:
            with urllib.request.urlopen(image_arg, timeout=60) as resp:
                data = resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            sys.stderr.write(f"error: failed to fetch {image_arg}: {e}\n")
            sys.exit(1)
        return _write_temp_image(data, hint_name=image_arg.rsplit("/", 1)[-1])
    if image_arg.startswith("data:"):
        # data:image/png;base64,XXXX
        try:
            header, b64 = image_arg.split(",", 1)
            data = base64.b64decode(b64)
        except (ValueError, base64.binascii.Error) as e:
            sys.stderr.write(f"error: malformed data URL: {e}\n")
            sys.exit(2)
        return _write_temp_image(data, hint_name=None)
    path = Path(image_arg)
    if not path.exists():
        sys.stderr.write(f"error: image not found: {image_arg}\n")
        sys.exit(4)
    return path, False


def _write_temp_image(data: bytes, hint_name: str | None) -> tuple[Path, bool]:
    mime = sniff_mime(data, hint_name)
    ext = mime.split("/")[1].split("+")[0] if "/" in mime else "png"
    fd, name = tempfile.mkstemp(suffix=f".{ext}", prefix="mimoskill-ocr-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except OSError as e:
        sys.stderr.write(f"error: cannot write temp image: {e}\n")
        sys.exit(1)
    return Path(name), True


def run_tesseract(
    *, image_args: list[str], lang_arg: str, extra_prompt: str | None
) -> str:
    """Run tesseract over one or more images, return concatenated text."""
    if extra_prompt:
        sys.stderr.write(
            "note: --prompt is ignored on tesseract engine (no LLM in the loop).\n"
        )
    chunks: list[str] = []
    for arg in image_args:
        path, is_temp = resolve_to_local_file(arg)
        try:
            r = subprocess.run(
                ["tesseract", str(path), "-", "-l", lang_arg],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            sys.stderr.write(
                "error: tesseract not found on PATH. Install:\n"
                "  macOS:   brew install tesseract tesseract-lang\n"
                "  Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                "  Windows: https://github.com/UB-Mannheim/tesseract/wiki\n"
            )
            sys.exit(1)
        finally:
            if is_temp:
                try:
                    path.unlink()
                except OSError:
                    pass
        if r.returncode != 0:
            sys.stderr.write(f"tesseract failed for {arg}: {r.stderr.strip()}\n")
            sys.exit(1)
        chunks.append(r.stdout.rstrip())
    return "\n\n".join(c for c in chunks if c)


def run_tesseract_boxes(
    *, image_args: list[str], lang_arg: str, min_conf: float = 40.0
) -> list[dict[str, Any]]:
    """Word-level boxes via tesseract TSV. Returns [{text,x,y,w,h,conf}].

    TSV columns: level page block par line word left top width height conf text.
    We keep word-level rows (level==5) with non-empty text above min_conf.
    """
    boxes: list[dict[str, Any]] = []
    for arg in image_args:
        path, is_temp = resolve_to_local_file(arg)
        try:
            r = subprocess.run(
                ["tesseract", str(path), "stdout", "-l", lang_arg, "tsv"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            sys.stderr.write(
                "error: tesseract not found on PATH. Install:\n"
                "  macOS:   brew install tesseract tesseract-lang\n"
                "  Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                "  Windows: https://github.com/UB-Mannheim/tesseract/wiki\n"
            )
            sys.exit(1)
        finally:
            if is_temp:
                try:
                    path.unlink()
                except OSError:
                    pass
        if r.returncode != 0:
            sys.stderr.write(f"tesseract failed for {arg}: {r.stderr.strip()}\n")
            sys.exit(1)
        lines = r.stdout.splitlines()
        for line in lines[1:]:  # skip header
            cols = line.split("\t")
            if len(cols) < 12:
                continue
            if cols[0] != "5":  # word level
                continue
            text = cols[11].strip()
            if not text:
                continue
            try:
                conf = float(cols[10])
            except ValueError:
                conf = -1.0
            if conf < min_conf:
                continue
            try:
                boxes.append(
                    {
                        "text": text,
                        "x": int(cols[6]),
                        "y": int(cols[7]),
                        "w": int(cols[8]),
                        "h": int(cols[9]),
                        "conf": round(conf, 1),
                    }
                )
            except ValueError:
                continue
    return boxes


# --- HTTP -------------------------------------------------------------------

POLLINATIONS_URL = "https://text.pollinations.ai/openai"
POLLINATIONS_DEFAULT_MODEL = "openai"  # vision-capable, free, no key


def post(url: str, body: dict[str, Any], api_key: str | None, stream: bool, *, engine: str) -> Any:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
        "User-Agent": "mimoskill-ocr/0.1",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        url,
        method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    try:
        return urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        snippet = e.read().decode("utf-8", "replace")
        sys.stderr.write(f"{engine} returned HTTP {e.code}: {snippet}\n")
        sys.exit(1)
    except urllib.error.URLError as e:
        sys.stderr.write(f"connection failed ({engine}): {e}\n")
        if engine == "pollinations":
            # pollinations.ai is often slow / unreachable from mainland China.
            # Point at the offline & domestic-friendly alternatives.
            sys.stderr.write(
                "  pollinations.ai can be unreachable from mainland China.\n"
                "  Alternatives:\n"
                "    1. Install tesseract for offline OCR (text mode only):\n"
                "         macOS:   brew install tesseract tesseract-lang\n"
                "         Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                "         Windows: https://github.com/UB-Mannheim/tesseract/wiki\n"
                "       then re-run: python3 ocr.py --engine tesseract --lang Chinese <image>\n"
                "    2. Use MiMo: export MIMO_API_KEY=sk-xxxx ; python3 ocr.py <image>\n"
                "    3. Use a network proxy (set HTTPS_PROXY env var) and retry.\n"
            )
        sys.exit(1)


def stream_chat(resp: Any) -> tuple[str, str]:
    """Stream SSE chunks; returns (full_content, full_reasoning)."""
    buf_content: list[str] = []
    buf_reasoning: list[str] = []
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        choice = chunk.get("choices", [{}])[0]
        delta = choice.get("delta", {})
        if r := delta.get("reasoning_content"):
            buf_reasoning.append(r)
            sys.stderr.write(r)
            sys.stderr.flush()
        if c := delta.get("content"):
            buf_content.append(c)
            sys.stdout.write(c)
            sys.stdout.flush()
    sys.stdout.write("\n")
    return "".join(buf_content), "".join(buf_reasoning)


def non_stream_chat(resp: Any) -> tuple[str, str, dict[str, Any]]:
    """Returns (content, reasoning_content, usage)."""
    payload = json.loads(resp.read().decode("utf-8"))
    msg = payload["choices"][0]["message"]
    return (
        msg.get("content") or "",
        msg.get("reasoning_content") or "",
        payload.get("usage") or {},
    )


# --- CLI --------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "images",
        nargs="*",
        metavar="IMAGE",
        help="image: local path, http(s) URL, data: URL, or `-` for stdin",
    )
    p.add_argument(
        "--mode",
        choices=list(MODE_PROMPTS),
        default="text",
        help="output mode (default: text)",
    )
    p.add_argument(
        "--model",
        default=None,
        help="MiMo vision model (default: $MIMO_OCR_MODEL / $MIMO_MODEL if "
        "vision-capable / mimo-v2.5). Non-vision models are auto-switched.",
    )
    p.add_argument(
        "--lang",
        default=None,
        help="primary language hint, e.g. 'Chinese', 'zh', '日本語'",
    )
    p.add_argument("--max-tokens", type=int, default=4096)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument(
        "--engine",
        choices=["auto", "mimo", "tesseract", "pollinations"],
        default=os.environ.get("MIMO_OCR_ENGINE", "auto"),
        help="OCR backend. auto = mimo (if MIMO_API_KEY) > tesseract (if "
        "installed and --mode=text) > pollinations. tesseract is fully local "
        "(no key, no network) — recommended when pollinations is unreachable "
        "(e.g. behind GFW). default: %(default)s",
    )
    p.add_argument(
        "--base-url",
        default=os.environ.get("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"),
        help="MiMo OpenAI-compat endpoint, ignored when --engine=pollinations "
        "(default: %(default)s)",
    )
    p.add_argument(
        "--pollinations-model",
        default=os.environ.get("POLLINATIONS_MODEL", POLLINATIONS_DEFAULT_MODEL),
        help="model id when --engine=pollinations (default: %(default)s)",
    )
    p.add_argument(
        "--prompt",
        default=None,
        help="extra instruction appended to the mode prompt",
    )
    p.add_argument("--json", action="store_true", help="wrap stdout as JSON envelope")
    p.add_argument("--stream", action="store_true", help="stream the response")
    p.add_argument(
        "--boxes",
        action="store_true",
        help="word-level bounding boxes via tesseract TSV (for computer-use: "
        "maps on-screen text to click coordinates). Local, no key/network. "
        "Output: JSON array of {text,x,y,w,h,conf}. Implies --engine tesseract.",
    )
    args = p.parse_args()

    api_key = os.environ.get("MIMO_API_KEY")

    # --boxes: word-level bounding boxes (computer-use coordinate mapping).
    # Tesseract-only and resolved before everything else so it ignores --engine
    # / --mode. Needs the images resolved first.
    if args.boxes:
        if not tesseract_available():
            sys.stderr.write(
                "error: --boxes needs tesseract (local OCR with coordinates).\n"
                "  macOS:   brew install tesseract tesseract-lang\n"
                "  Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                "  Windows: https://github.com/UB-Mannheim/tesseract/wiki\n"
            )
            sys.exit(3)
        box_args = args.images
        if not box_args and not sys.stdin.isatty():
            box_args = ["-"]
        if not box_args:
            sys.stderr.write("error: --boxes needs an IMAGE arg or piped bytes.\n")
            sys.exit(2)
        lang_arg = map_lang_to_tesseract(args.lang)
        sys.stderr.write(f"[ocr] mode=boxes engine=tesseract lang={lang_arg} images={len(box_args)}\n")
        boxes = run_tesseract_boxes(image_args=box_args, lang_arg=lang_arg)
        if args.json:
            print(json.dumps({"engine": "tesseract", "lang": lang_arg, "boxes": boxes}, ensure_ascii=False))
        else:
            for b in boxes:
                print(f"{b['text']}\t{b['x']},{b['y']},{b['w']},{b['h']}")
        return

    # Resolve engine.
    if args.engine == "mimo":
        engine = "mimo"
        if not api_key:
            sys.stderr.write(
                "error: --engine mimo requires MIMO_API_KEY.\n"
                "  set one at https://platform.xiaomimimo.com/#/console/api-keys\n"
                "  OR drop the flag to use auto fallback (tesseract / pollinations).\n"
            )
            sys.exit(3)
    elif args.engine == "tesseract":
        engine = "tesseract"
        if not tesseract_available():
            sys.stderr.write(
                "error: --engine tesseract requested but tesseract is not on PATH.\n"
                "  macOS:   brew install tesseract tesseract-lang\n"
                "  Ubuntu:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim\n"
                "  Windows: https://github.com/UB-Mannheim/tesseract/wiki\n"
            )
            sys.exit(3)
        if args.mode != "text":
            sys.stderr.write(
                f"error: --engine tesseract only supports --mode text "
                f"(you passed --mode {args.mode}). tesseract is an OCR engine, "
                f"not an LLM — `describe` / `structured` / `markdown` need a "
                f"vision LLM (mimo or pollinations).\n"
            )
            sys.exit(2)
    elif args.engine == "pollinations":
        engine = "pollinations"
    else:  # auto
        if api_key:
            engine = "mimo"
        elif args.mode == "text" and tesseract_available():
            engine = "tesseract"
            sys.stderr.write(
                "[engine] auto -> tesseract (local, no network). "
                "Set MIMO_API_KEY for higher quality (mimo-v2.5).\n"
            )
        else:
            engine = "pollinations"
            hint = ""
            if args.mode != "text" and tesseract_available():
                hint = (
                    " (tesseract is installed but only handles --mode text;"
                    " using pollinations for this mode)"
                )
            sys.stderr.write(
                f"[engine] auto -> pollinations (free, no key){hint}.\n"
                "  Set MIMO_API_KEY for higher quality (mimo-v2.5), "
                "or install tesseract for offline OCR.\n"
            )

    # Resolve images: explicit args, else stdin if not a TTY.
    raw_args = args.images
    if not raw_args and not sys.stdin.isatty():
        raw_args = ["-"]
    if not raw_args:
        sys.stderr.write(
            "error: no image given. Pass one or more IMAGE args or pipe bytes "
            "on stdin. See `ocr.py --help`.\n"
        )
        sys.exit(2)

    # Tesseract branch — fully local, no LLM call, no data-URL conversion.
    if engine == "tesseract":
        lang_arg = map_lang_to_tesseract(args.lang)
        sys.stderr.write(
            f"[ocr] engine=tesseract mode=text lang={lang_arg} images={len(raw_args)}\n"
        )
        text = run_tesseract(
            image_args=raw_args, lang_arg=lang_arg, extra_prompt=args.prompt
        )
        if args.json:
            envelope = {
                "mode": "text",
                "engine": "tesseract",
                "model": f"tesseract:{lang_arg}",
                "images": len(raw_args),
                "content": text,
                "reasoning_content": "",
                "usage": {},
            }
            print(json.dumps(envelope, ensure_ascii=False, indent=2))
        else:
            print(text)
        return

    image_urls = [resolve_image_arg(a) for a in raw_args]

    if engine == "mimo":
        model, note = pick_model(args.model)
        if note:
            sys.stderr.write(note)
    else:
        if args.model:
            sys.stderr.write(
                f"note: --model is mimo-specific; ignoring on pollinations "
                f"(use --pollinations-model instead).\n"
            )
        model = args.pollinations_model

    sys.stderr.write(
        f"[ocr] engine={engine} mode={args.mode} model={model} images={len(image_urls)}\n"
    )

    messages = build_messages(
        mode=args.mode,
        image_urls=image_urls,
        lang=args.lang,
        extra_prompt=args.prompt,
    )

    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": args.temperature,
        "stream": args.stream,
    }
    if engine == "mimo":
        # MiMo's quirk: max_completion_tokens, not max_tokens.
        body["max_completion_tokens"] = args.max_tokens
        url = args.base_url.rstrip("/") + "/chat/completions"
        auth = api_key
    else:
        body["max_tokens"] = args.max_tokens
        url = POLLINATIONS_URL
        auth = None

    resp = post(url, body, auth, args.stream, engine=engine)

    if args.stream:
        content, reasoning = stream_chat(resp)
        usage: dict[str, Any] = {}
    else:
        content, reasoning, usage = non_stream_chat(resp)
        if reasoning:
            sys.stderr.write(f"[reasoning]\n{reasoning}\n[/reasoning]\n\n")
        if args.json:
            envelope = {
                "mode": args.mode,
                "model": model,
                "images": len(image_urls),
                "content": content,
                "reasoning_content": reasoning,
                "usage": usage,
            }
            print(json.dumps(envelope, ensure_ascii=False, indent=2))
        else:
            print(content)
        return

    # Streaming + --json: emit envelope after the streamed body.
    if args.json:
        envelope = {
            "mode": args.mode,
            "model": model,
            "images": len(image_urls),
            "content": content,
            "reasoning_content": reasoning,
            "usage": {},
        }
        sys.stdout.write("\n---\n")
        sys.stdout.write(json.dumps(envelope, ensure_ascii=False, indent=2))
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
