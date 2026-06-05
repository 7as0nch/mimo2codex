# Windows: use mimo2codex for Codex CLI only, without touching Codex Desktop

<p>
  <a href="./codex-cli-isolated-windows.md"><strong>English</strong></a> ·
  <a href="./codex-cli-isolated-windows.zh.md">简体中文</a>
</p>

This guide describes a Windows-only isolated launch flow: `scripts/codex-mimo-isolated.ps1` starts the mimo2codex proxy and makes the current Codex CLI session use a separate `CODEX_HOME`.

## When to use this

Use it when you want:

- Codex CLI to use MiMo via mimo2codex.
- Codex Desktop to keep using its existing OpenAI/ChatGPT config.
- To never write to or overwrite `%USERPROFILE%\.codex`.
- To not start `mimo2codex` by hand every time.
- To not type an API key every time.

If instead you want both Codex CLI **and** Codex Desktop to use mimo2codex globally, prefer "Codex Enable" in the Admin Web UI.

## How it works

The script does four things:

1. Points the current process's `CODEX_HOME` at `%USERPROFILE%\.codex-mimo`.
2. Writes a minimal `auth.json` / `config.toml` into that isolated directory if they don't exist yet.
3. Checks whether a mimo2codex proxy is already listening on `127.0.0.1:8788`; if not, starts one in the background.
4. Launches Codex CLI, forwarding all arguments straight through to `codex`.

Because `CODEX_HOME` is set only inside the script's process, the default `%USERPROFILE%\.codex` is never modified and Codex Desktop is unaffected.

## Prerequisites

Install mimo2codex:

```powershell
npm install -g mimo2codex
```

Install Codex CLI and confirm `codex` is on PATH:

```powershell
codex --version
```

Prepare an API key. The recommended way is mimo2codex's built-in `.env` loader:

```powershell
mimo2codex init
notepad "$env:USERPROFILE\.mimo2codex\.env"
```

Fill in your `.env`:

```text
MIMO_API_KEY=your-key
MIMO_BASE_URL=https://token-plan-ams.xiaomimimo.com/v1
```

Notes:

- `tp-` Token Plan keys usually use a Token Plan host such as `token-plan-ams`.
- `sk-` pay-as-you-go keys: configure per the MiMo console or the mimo2codex docs.
- Never hardcode a real key into `scripts/codex-mimo-isolated.ps1`.

## Usage

Run it from any project directory:

```powershell
.\scripts\codex-mimo-isolated.ps1
```

It prints something like:

```text
[*] CODEX_HOME:        C:\Users\you\.codex-mimo
[*] mimo2codex API:   http://127.0.0.1:8788/v1
[*] mimo2codex admin: http://127.0.0.1:8788/admin/
```

then drops you into Codex CLI.

## Non-interactive test

You can forward arguments to Codex:

```powershell
.\scripts\codex-mimo-isolated.ps1 exec --json --ephemeral "Reply with exactly: MIMO_OK"
```

A clean response confirms that:

- Codex CLI is reading `%USERPROFILE%\.codex-mimo`.
- the mimo2codex proxy is listening.
- the MiMo key and upstream routing work.

## Start the proxy and prepare config only, without entering Codex

```powershell
.\scripts\codex-mimo-isolated.ps1 -NoLaunchCodex
```

This mode is handy for debugging proxy startup, opening the admin page, or verifying the isolated config.

## Default isolated config

The script writes `%USERPROFILE%\.codex-mimo\auth.json`:

```json
{
  "OPENAI_API_KEY": "mimo2codex-local"
}
```

This value only exists to pass Codex's local auth check. mimo2codex does not validate this inbound key; the real upstream MiMo key still comes from `MIMO_API_KEY` or `%USERPROFILE%\.mimo2codex\.env`.

The script writes `%USERPROFILE%\.codex-mimo\config.toml`:

```toml
model = "mimo-v2.5-pro"
model_provider = "mimo"
model_context_window = 1000000
model_max_output_tokens = 131072

[model_providers.mimo]
name = "MiMo (via mimo2codex)"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = true
request_max_retries = 1
```

## Difference from Codex Enable

The Admin Web UI's "Codex Enable" writes to the default Codex directory:

```text
%USERPROFILE%\.codex\auth.json
%USERPROFILE%\.codex\config.toml
```

This script uses an isolated directory:

```text
%USERPROFILE%\.codex-mimo\auth.json
%USERPROFILE%\.codex-mimo\config.toml
```

So it only affects Codex CLI sessions started through this script, and leaves Codex Desktop alone.

### Why not just set a Windows user-level environment variable?

A user-level environment variable affects every new terminal. This script only affects the current Codex CLI session, which fits the "CLI uses MiMo, Desktop stays as-is" personal workflow better.
