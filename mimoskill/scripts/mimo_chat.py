#!/usr/bin/env python3
"""
mimo_chat.py — single-shot or streaming chat. Works WITHOUT any API key.

Engines (--engine):
  auto          (default) — mimo if MIMO_API_KEY set, else pollinations
  mimo          — Xiaomi MiMo V2.5 (best quality, needs MIMO_API_KEY)
  pollinations  — pollinations.ai free public chat endpoint. NO KEY REQUIRED

When the mimo engine is used, handles the MiMo-specific quirks:
  - max_completion_tokens (not max_tokens)
  - vision via mimo-v2.5 (and the required text part next to
    image_url, otherwise MiMo 400s with "text is not set")
  - web_search builtin: auto-enabled on pay-as-you-go (sk-*) keys, skipped on
    token-plan (tp-*) keys. Model decides when to invoke (tool_choice: auto).
    Requires the Web Search Plugin to be activated in the MiMo console.
  - reasoning_content extraction

Usage:
    # Zero-setup
    python3 mimo_chat.py "your prompt"
    python3 mimo_chat.py --image https://x/y.png "describe"

    # MiMo key — gets best quality + native web search (when sk-*)
    export MIMO_API_KEY=sk-xxxx
    python3 mimo_chat.py "今天上海天气?"
    python3 mimo_chat.py --stream "tell me a story"

Only depends on the standard library — no `openai` SDK install needed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from typing import Any


def build_messages(prompt: str, image: str | None) -> list[dict[str, Any]]:
    if image is None:
        return [{"role": "user", "content": prompt}]
    # MiMo requires BOTH image_url and a text part — sending image-only returns
    # 400 "Param Incorrect: `text` is not set". If the user gave no prompt,
    # fall back to a single space (the model will infer intent from the image).
    return [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image}},
                {"type": "text", "text": prompt or " "},
            ],
        }
    ]


POLLINATIONS_URL = "https://text.pollinations.ai/openai"
POLLINATIONS_DEFAULT_MODEL = "openai"  # vision-capable, free, no key

# MiMo retired its v2 generation (offline 2026-06-30). This script calls MiMo
# directly (no proxy alias layer), so old names 400 upstream — coerce them to
# their live replacement (mimo-v2-pro → mimo-v2.5-pro; omni/flash → mimo-v2.5).
RETIRED_MIMO_MODELS = {"mimo-v2-omni", "mimo-v2-flash", "mimo-v2-pro"}


def build_body(
    *,
    prompt: str,
    image: str | None,
    model: str,
    stream: bool,
    enable_web_search: bool,
    max_tokens: int,
    temperature: float,
    engine: str,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": build_messages(prompt, image),
        "temperature": temperature,
        "stream": stream,
    }
    if engine == "mimo":
        # MiMo's quirk: max_completion_tokens, not max_tokens.
        body["max_completion_tokens"] = max_tokens
    else:
        body["max_tokens"] = max_tokens
    if enable_web_search:
        # MiMo native web_search builtin. The model decides whether to invoke
        # it (tool_choice=auto). Requires the Web Search Plugin to be
        # activated at https://platform.xiaomimimo.com/#/console/plugin —
        # without that, MiMo returns 400 and the error body is printed.
        body["tools"] = [{"type": "web_search"}]
        body["tool_choice"] = "auto"
    return body


def post(url: str, body: dict[str, Any], api_key: str | None, stream: bool, *, engine: str) -> Any:
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
        "User-Agent": "mimoskill/0.1",
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
        sys.exit(1)


def stream_chat(resp: Any) -> None:
    annotations: list[dict[str, Any]] = []
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
        for ann in delta.get("annotations") or []:
            annotations.append(ann)
        # Print reasoning_content dimly to stderr, content to stdout
        if r := delta.get("reasoning_content"):
            sys.stderr.write(r)
            sys.stderr.flush()
        if c := delta.get("content"):
            sys.stdout.write(c)
            sys.stdout.flush()
    sys.stdout.write("\n")
    if annotations:
        sys.stderr.write("\n--- citations ---\n")
        for a in annotations:
            sys.stderr.write(f"  • {a.get('title', '(no title)')}\n    {a.get('url')}\n")


def non_stream_chat(resp: Any) -> None:
    payload = json.loads(resp.read().decode("utf-8"))
    msg = payload["choices"][0]["message"]
    if reasoning := msg.get("reasoning_content"):
        sys.stderr.write(f"[reasoning]\n{reasoning}\n[/reasoning]\n\n")
    print(msg.get("content") or "")
    if anns := msg.get("annotations"):
        sys.stderr.write("\n--- citations ---\n")
        for a in anns:
            sys.stderr.write(f"  • {a.get('title', '(no title)')}\n    {a.get('url')}\n")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("prompt", nargs="?", default="", help="user message text")
    p.add_argument("--model", default=os.environ.get("MIMO_MODEL", "mimo-v2.5-pro"))
    p.add_argument("--image", help="image URL to attach (forces vision-capable model)")
    p.add_argument("--stream", action="store_true", help="stream the response")
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--temperature", type=float, default=0.7)
    p.add_argument(
        "--engine",
        choices=["auto", "mimo", "pollinations"],
        default=os.environ.get("MIMO_CHAT_ENGINE", "auto"),
        help="chat backend. auto = mimo if MIMO_API_KEY set, else pollinations "
        "(free, no key required). default: %(default)s",
    )
    p.add_argument(
        "--base-url",
        default=os.environ.get("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"),
        help="MiMo endpoint, ignored when --engine=pollinations "
        "(tp-* keys use https://token-plan-cn.xiaomimimo.com/v1)",
    )
    p.add_argument(
        "--pollinations-model",
        default=os.environ.get("POLLINATIONS_MODEL", POLLINATIONS_DEFAULT_MODEL),
        help="model id when --engine=pollinations (default: %(default)s)",
    )
    args = p.parse_args()

    api_key = os.environ.get("MIMO_API_KEY")

    # Resolve engine.
    if args.engine == "mimo":
        engine = "mimo"
        if not api_key:
            sys.stderr.write(
                "error: --engine mimo requires MIMO_API_KEY.\n"
                "  get one at https://platform.xiaomimimo.com/#/console/api-keys\n"
                "  OR drop the flag to fall back to pollinations (free, no key required):\n"
                "      python3 mimo_chat.py <prompt>\n"
            )
            sys.exit(3)
    elif args.engine == "pollinations":
        engine = "pollinations"
    else:  # auto
        engine = "mimo" if api_key else "pollinations"
        if engine == "pollinations":
            sys.stderr.write(
                "[engine] auto -> pollinations (free, no key). "
                "Set MIMO_API_KEY for higher quality (mimo-v2.5).\n"
            )

    if not args.prompt and not args.image:
        sys.stderr.write("error: pass a prompt and/or --image\n")
        sys.exit(2)

    enable_web_search = False
    if engine == "mimo":
        model = args.model
        # Retired v2 names 400 upstream — coerce to the live replacement first.
        if model in RETIRED_MIMO_MODELS:
            replacement = "mimo-v2.5-pro" if model == "mimo-v2-pro" else "mimo-v2.5"
            sys.stderr.write(
                f"note: model '{model}' is retired; using {replacement} for this call.\n"
            )
            model = replacement
        # Auto-bump to a vision model if user passed --image with a non-vision model.
        if args.image and model != "mimo-v2.5" and not model.startswith("mimo-v2.5["):
            sys.stderr.write(
                f"note: --image given but model is '{model}' which doesn't see images.\n"
                f"      switching to mimo-v2.5 for this call.\n"
            )
            model = "mimo-v2.5"
        url = args.base_url.rstrip("/") + "/chat/completions"
        auth: str | None = api_key
        # MiMo native web_search: pay-as-you-go (sk-*) supports it, token-plan
        # (tp-*) does not. Always include the tool on sk-* and let the model
        # decide via tool_choice=auto — no extra flag needed.
        enable_web_search = bool(api_key and api_key.startswith("sk-"))
    else:
        # Pollinations: pick the configured vision-capable model. The user's
        # --model (mimo-*) is mimo-specific so we don't honor it here unless
        # they explicitly passed --pollinations-model.
        model = args.pollinations_model
        url = POLLINATIONS_URL
        auth = None

    sys.stderr.write(
        f"[chat] engine={engine} model={model}"
        + (" web_search=on" if enable_web_search else "")
        + "\n"
    )

    body = build_body(
        prompt=args.prompt,
        image=args.image,
        model=model,
        stream=args.stream,
        enable_web_search=enable_web_search,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        engine=engine,
    )

    resp = post(url, body, auth, args.stream, engine=engine)
    if args.stream:
        stream_chat(resp)
    else:
        non_stream_chat(resp)


if __name__ == "__main__":
    main()
