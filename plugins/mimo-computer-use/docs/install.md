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

- If Trope CUA is installed and permissions are granted, Codex gets a JSON state
  summary.
- If the adapter is missing, Codex gets a JSON setup diagnostic pointing at the
  Trope CUA install docs.

## Codex plugin

The plugin is self-contained under `plugins/mimo-computer-use/`.

Codex reads `.mcp.json` from the plugin manifest and starts:

```bash
node ./server/index.mjs
```

No npm dependencies are required for the plugin server itself.

## Backend: Trope CUA (macOS + Windows)

mimo-computer-use uses a single backend,
[Trope CUA](https://github.com/voctory/trope-cua), on **macOS and Windows only**.
It is the default — `MIMO_COMPUTER_USE_BACKEND` may be left unset (`auto`) or set
explicitly to `trope`.

Trope CUA is distributed as **source**. `npm run install-adapter` automates the
whole flow: it `git clone`s the repo into `~/.mimo2codex/adapters/trope-cua`, then
runs the platform build script. Prerequisites:

- Both: `git`
- macOS 14+: Xcode Command Line Tools; afterward grant TropeCUA.app
  Accessibility + Screen Recording permissions. Build script: `scripts/install-macos.sh`.
- Windows 10 1903+/11: PowerShell + the .NET SDK matching `global.json`.
  Build script: `scripts\install-windows.ps1 -SelfContained`.

Install and verify:

```bash
cd plugins/mimo-computer-use
npm run install-adapter   # git clone + platform build script
npm run doctor            # confirms `trope-cua` is detected on PATH
```

Then self-check the installed command:

```bash
trope-cua --help
trope-cua check_permissions
trope-cua list_windows
```

Trope CUA upstream: <https://github.com/voctory/trope-cua>

Override the command or its args when the executable is named differently or
needs different startup args (the adapter invokes `trope-cua mcp` by default):

```bash
MIMO_COMPUTER_USE_TROPE_CMD=/path/to/trope-cua
MIMO_COMPUTER_USE_TROPE_ARGS="mcp"
```
