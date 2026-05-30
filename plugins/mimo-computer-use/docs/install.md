# Install and Configure

## Enable in an existing mimo2codex + Codex setup

This plugin is independent from the mimo2codex proxy. You do not change the
model provider config; you only add one MCP server to Codex.

Recommended:

1. Open `http://127.0.0.1:8788/admin/`.
2. Go to **Plugins**.
3. Enable **MiMo Computer Use**.
4. Restart Codex CLI / Desktop.

For deployments, set the unified plugin env var before starting mimo2codex:

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

`MIMO2CODEX_PLUGIN` has priority over the admin UI. Use
`mimo-computer-use` / `computer-use` / `1` / `on` to enable, or
`0` / `off` / `none` to disable built-in plugins.

Manual setup:

Append this to `~/.codex/config.toml`:

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO_COMPUTER_USE_BACKEND = "auto"
```

Restart Codex Desktop after saving. Existing mimo2codex settings are preserved;
newer mimo2codex config switching keeps `[mcp_servers.*]` sections intact.

Smoke test in Codex:

```text
Use the mimo-computer-use computer_state tool to inspect the current desktop.
```

Expected outcomes:

- If the platform adapter is installed and permissions are granted, Codex gets a
  JSON state summary.
- If the adapter is missing, Codex gets a JSON setup diagnostic with the backend
  to install.

## Codex plugin

The plugin is self-contained under `plugins/mimo-computer-use/`.

Codex reads `.mcp.json` from the plugin manifest and starts:

```bash
node ./server/index.mjs
```

No npm dependencies are required for the plugin server itself.

## macOS backend

The built-in installer uses Homebrew:

```bash
cd plugins/mimo-computer-use
npm run install-adapter
```

Equivalent manual command:

```bash
brew install steipete/tap/peekaboo
```

Peekaboo upstream:

<https://github.com/openclaw/Peekaboo>

Then grant macOS permissions:

- Screen Recording
- Accessibility

Verify:

```bash
peekaboo --help
cd plugins/mimo-computer-use
npm run doctor
```

If the binary is not named `peekaboo`, set:

```bash
MIMO_COMPUTER_USE_PEEKABOO_CMD=/path/to/peekaboo
```

## Windows backend

The built-in installer uses uv when available:

```powershell
cd plugins\mimo-computer-use
npm run install-adapter
```

Equivalent manual command:

```powershell
uv tool install windows-mcp
```

If `windows-mcp` is not on PATH but `uvx` exists, the adapter can run:

```powershell
uvx windows-mcp serve
```

Windows-MCP upstream:

<https://github.com/CursorTouch/Windows-MCP>

Verify that the command is on PATH, then run:

```powershell
cd plugins\mimo-computer-use
npm run doctor
```

Override the command or server args when needed:

```powershell
$env:MIMO_COMPUTER_USE_WINDOWS_MCP_CMD = "windows-mcp"
$env:MIMO_COMPUTER_USE_WINDOWS_MCP_ARGS = "mcp"
```

## Trope CUA backend

Trope CUA is optional and experimental:

<https://trope.ai/cua>

Enable it explicitly:

```bash
MIMO_COMPUTER_USE_BACKEND=trope
```
