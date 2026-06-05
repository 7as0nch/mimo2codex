# Install and Configure

## Enable in an existing mimo2codex + Codex setup

This plugin is independent from the mimo2codex proxy. You don't change the model
provider config; you only add one MCP server to Codex.

Recommended:

1. Open `http://127.0.0.1:8788/admin/`.
2. Go to **Plugins**.
3. Enable **MiMo Computer Use**.
4. Click **Install dependencies** (installs nut.js). Tick *"also download the
   glowing-cursor runtime (Electron)"* if you want the on-desktop cursor.
5. Restart Codex CLI / Desktop.

For deployments, set the unified plugin env var before starting mimo2codex:

```bash
MIMO2CODEX_PLUGIN=mimo-computer-use
```

`MIMO2CODEX_PLUGIN` has priority over the admin UI. Use
`mimo-computer-use` / `computer-use` / `1` / `on` to enable, or
`0` / `off` / `none` to disable built-in plugins.

Manual setup — append this to `~/.codex/config.toml`:

```toml
[mcp_servers.mimo-computer-use]
command = "node"
args = ["<mimo2codex-install-root>/plugins/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO2CODEX_ADMIN_URL = "http://127.0.0.1:8788"
```

`MIMO2CODEX_ADMIN_URL` lets the plugin stream its actions to the admin
**Computer Use Monitor** page. Restart Codex Desktop after saving; existing
mimo2codex settings and other `[mcp_servers.*]` sections are preserved.

Smoke test in Codex:

```text
Use the mimo-computer-use computer_state tool to look at the current screen, then click something.
```

- If nut.js is installed, Codex gets a screenshot (image + path + size/scale).
- If it isn't, Codex gets a JSON setup diagnostic telling it to install.

## Dependencies (pure Node — no toolchain)

Desktop control uses [nut.js](https://nutjs.dev/), which ships prebuilt native
bindings. Installing the plugin's deps is just `npm install`; there is **no git
clone, Xcode, or .NET build** (that was the old Trope CUA backend, now removed).

```bash
cd plugins/mimo-computer-use
npm run install-adapter                 # npm install → nut.js
npm run doctor                          # nut.js / Electron / platform / permissions
```

Electron (optional, for the on-desktop glowing cursor) is large, so it is only
installed when you ask — tick the box in the admin Plugins page, or:

```bash
node ./server/index.mjs --install-adapter --with-electron
```

macOS: after install, grant the host app (terminal / Codex) **Accessibility** +
**Screen Recording** in System Settings → Privacy & Security.
