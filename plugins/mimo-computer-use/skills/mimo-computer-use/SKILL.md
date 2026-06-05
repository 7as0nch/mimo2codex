---
name: mimo-computer-use
description: Use local desktop computer-control tools exposed by the mimo-computer-use MCP plugin (pure Node / nut.js). Always screenshot before acting, use small reversible steps, and surface setup/permission errors clearly.
---

# MiMo Computer Use

Use this skill when the user asks Codex to operate the local desktop through the
`mimo-computer-use` plugin.

Workflow:

1. Call `computer_state` before clicking or typing. It returns the screen
   `size`, a `scale`, a screenshot path, a (downscaled) screenshot image, and —
   by default — OCR'd text `targets` with click coordinates.
   - **If you can see the screenshot image**: look at it and choose an `x/y`.
     (The image arrives in the next turn for vision models; it's downscaled to
     keep the session small — that's expected.)
   - **If you can't see images** (text-only model): the image is stripped and
     you'll get an OCR hint — use the `targets` list and click by `target` text.
     This needs tesseract installed. If you have neither the image nor any
     `targets`, DO NOT guess coordinates — tell the user to install tesseract or
     switch to a vision model (e.g. mimo-v2.5).
2. `computer_click` takes `x/y` (from the image) or a `target` text (matched
   against OCR `targets`). The `targets` coordinates are already in screen-mouse
   space — click them as-is.
3. Do one small action per step, then call `computer_state` again to confirm.
4. If `diagnose` / a tool reports `adapter_missing`, tell the user to enable the
   plugin and click **Install dependencies** in the admin Plugins page (or run
   `npm run install-adapter`). On macOS, remind them to grant Accessibility +
   Screen Recording to the host app.
5. You are moving the user's real mouse. If they say stop, stop. If you get a
   `stopped_by_user` error (overlay Stop button), do not retry until they ask
   you to resume. If you get a `user_intervened` error, the user moved the mouse
   to take over or correct you — STOP automating, ask what they want changed,
   then call `computer_state` to re-sync before continuing.

Do not use this plugin for shell commands, file writes, process control,
registry edits, or system settings changes.
