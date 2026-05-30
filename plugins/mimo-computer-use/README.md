# MiMo Computer Use

MiMo Computer Use is a local Codex MCP plugin that exposes a small, conservative
desktop-control surface to MiMo, DeepSeek, and other OpenAI-compatible
function-calling models routed through mimo2codex.

It does not implement OpenAI's hosted `computer_use_preview` protocol. Instead,
it registers ordinary MCP tools that Codex can execute locally and that
mimo2codex can pass through as regular function tools.

## Quick start

If mimo2codex already works in Codex, the easiest path is:

1. Open the admin console at `http://127.0.0.1:8788/admin/`.
2. Go to **Plugins**.
3. Enable **MiMo Computer Use**.
4. Restart Codex CLI / Desktop so it loads the MCP server.
5. Run `npm run doctor`; if the adapter is missing, run
   `npm run install-adapter` and watch the progress output.

For deployment-style setups, lock the state with:

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

Supported current values:

- `mimo-computer-use`, `computer-use`, `1`, `on` — enable this built-in plugin.
- `0`, `off`, `none` — disable built-in plugins.

When `MIMO2CODEX_PLUGIN` is set, the admin switch is read-only. When it is
unset, the admin page can hot-write `~/.codex/config.toml`.

Manual configuration is still supported. Add the local MCP server to
`~/.codex/config.toml`:

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO_COMPUTER_USE_BACKEND = "auto"
```

Then restart Codex Desktop. In a new Codex thread, ask:

```text
Use mimo-computer-use computer_state to inspect the current desktop.
```

The plugin can load even before the platform adapter is installed. In that case
`computer_state` returns a setup diagnostic, such as "Peekaboo is not available"
on macOS or "Windows-MCP is not available" on Windows. Agents may then call
`computer_install_adapter` after explaining the third-party download plan to the
user.

## Tools

- `computer_state` — inspect the current app/window and return a JSON summary.
- `computer_click` — click by element/target hint or screen coordinates.
- `computer_type` — type literal text.
- `computer_key` — press a key or shortcut.
- `computer_scroll` — scroll the active view or a coordinate target.
- `computer_wait` — wait for UI to settle.
- `computer_install_adapter` — detect/install the missing platform adapter after
  user-facing explanation.

Tool results are text JSON only. When an adapter produces a screenshot, it should
return a local path in the JSON payload instead of embedding image bytes in the
tool result. This keeps MiMo and DeepSeek tool-result history compatible.

## Backends

- macOS: [Peekaboo](https://github.com/openclaw/Peekaboo), selected by default
  on `darwin`.
- Windows: [Windows-MCP](https://github.com/CursorTouch/Windows-MCP), selected
  by default on `win32`.
- Shared/experimental: [Trope CUA](https://trope.ai/cua), selected with
  `MIMO_COMPUTER_USE_BACKEND=trope`.

The plugin uses external-install detection only. It does not download or vendor
these projects.

## Diagnose and install

```bash
cd plugins/mimo-computer-use
npm run doctor
npm run install-adapter
```

## Run tests

```bash
cd plugins/mimo-computer-use
npm test
```
