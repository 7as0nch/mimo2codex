# Backend Contract

The plugin normalizes desktop automation into the `computer_*` MCP tools through
a single in-process backend interface.

## Interface

A backend module exports:

- `diagnose()` → `{ ok, backend, message, ... }`
- `computerState(args)` → `{ ok, size, scale, screenshot:{path,frameName,image?}, targets?[] }`
- `computerClick(args)` / `computerType(args)` / `computerKey(args)` / `computerScroll(args)`

`waitMs` lives in `adapters.mjs` (handled internally, never touches the OS).

## Current backend: nut.js (pure Node)

`server/lib/nutjs.mjs` implements the interface with
[`@nut-tree-fork/nut-js`](https://github.com/nut-tree/nut.js): real-cursor mouse
moves (it glides to the target), keyboard, and `screen.capture` screenshots.
nut.js ships prebuilt native bindings, so there is **no compiler / Xcode / .NET
toolchain** — the plugin's deps install with a plain `npm install`. It is loaded
lazily, so the MCP server still starts (and `diagnose()` reports `adapter_missing`
with an install hint) before `npm install` has run.

There is no accessibility/element tree (that was Trope CUA's native piece);
this backend is coordinate-first. Text-only models get clickable coordinates
from the OCR pass (`server/lib/ocr.mjs` → `mimoskill/scripts/ocr.py --boxes`).

## Coordinates & DPI

`computer_state` returns `size` (screen-mouse space, what nut.js uses) and a
`scale` factor (screenshot pixels ÷ logical width). On a HiDPI macOS display the
screenshot is `scale`× larger than the mouse space — divide coordinates read off
the image by `scale`. On typical Windows (100%) `scale` is 1.

## Required behavior

- Return JSON-serializable objects with `ok`; use `code` + `message` on errors.
- Keep the screenshot's large base64 only in the MCP image block, not the text JSON.
- Never throw out of the overlay / event side-channels — they are best-effort.
