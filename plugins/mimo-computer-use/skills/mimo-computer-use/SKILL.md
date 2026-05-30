---
name: mimo-computer-use
description: Use local desktop computer-control tools exposed by the mimo-computer-use MCP plugin. Prefer inspecting state before acting, use small reversible actions, and surface adapter permission/setup errors clearly.
---

# MiMo Computer Use

Use this skill when the user asks Codex to operate the local desktop through
the `mimo-computer-use` plugin.

Workflow:

1. Call `computer_state` before clicking or typing.
2. Prefer a target/element id from state over raw coordinates.
3. Use one small action per step, then re-check state.
4. If the adapter reports missing permissions or missing backend binaries, tell
   the user exactly what to install or grant.

Do not use this plugin for shell commands, file writes, process control,
registry edits, or system settings changes.
