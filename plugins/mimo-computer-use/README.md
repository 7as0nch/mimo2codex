# MiMo Computer Use

MiMo Computer Use is a local Codex MCP plugin that lets MiMo, DeepSeek, and other
OpenAI-compatible function-calling models (routed through mimo2codex) operate the
desktop — click, type, scroll, screenshot.

It is **pure Node**: desktop control is driven by [nut.js](https://nutjs.dev/),
which ships prebuilt native bindings, so installing it is a plain `npm install` —
**no Trope CUA, no git clone, no Xcode / .NET build toolchain**. It does not
implement OpenAI's hosted `computer_use_preview` protocol; it registers ordinary
MCP function tools that any tool-calling model can drive.

## How models perceive the screen (A+C)

- **Vision models** — `computer_state` returns the screenshot as an MCP image
  block (plus a saved path), so the model can look and pick a coordinate.
- **Text-only models** — call `computer_state` with `ocr: true` and the result
  also includes `targets`: a list of on-screen text with click coordinates
  (OCR via `mimoskill/scripts/ocr.py --boxes`, tesseract, local/offline). The
  model clicks a target by its text; `computer_click` maps it to a point.

## Quick start

1. Open the admin console at `http://127.0.0.1:8788/admin/` → **Plugins**.
2. Enable **MiMo Computer Use**, then click **Install dependencies** (installs
   nut.js). Tick *"also download the glowing-cursor runtime (Electron)"* if you
   want the on-desktop cursor.
3. Restart Codex CLI / Desktop so it loads the MCP server.
4. Watch the AI work on the **Computer Use Monitor** admin page.

macOS: grant the host app (your terminal / Codex) **Accessibility** + **Screen
Recording** in System Settings → Privacy & Security, or clicks/screenshots fail.

## Tools

- `computer_state` — screenshot + screen size + `scale`; `ocr:true` adds clickable text `targets`.
- `computer_click` — move the cursor (it glides) to `x/y` (or a `target` text) and click.
- `computer_type` — type literal text.
- `computer_key` — press a key/shortcut (`Enter`, `Ctrl+C`, `Cmd+L`, `Alt+Tab`…).
- `computer_scroll` — scroll the view.
- `computer_wait` — wait for the UI to settle (internal).
- `computer_install_adapter` — install nut.js (and optionally Electron) after telling the user.

## Glowing cursor (optional Electron overlay)

When Electron is installed, the plugin spawns a transparent, click-through,
always-on-top overlay that draws a glowing cyan cursor + click ripples on the
real desktop while the AI acts, plus a **Stop / Resume AI control** pill and a
global hotkey (`Ctrl/Cmd+Alt+Esc`). Without Electron everything still works — you
just won't see the desktop cursor (the Monitor page still shows it).

## Diagnose / install / test

```bash
cd plugins/mimo-computer-use
npm run doctor              # reports nut.js / Electron / platform / permissions
npm run install-adapter     # npm install (nut.js); add --with-electron for the overlay
npm test                    # node --test
```
