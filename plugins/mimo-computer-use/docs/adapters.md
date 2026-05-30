# Adapter Contract

Adapters normalize platform-specific desktop automation into six MCP tools.

## Required behavior

- Return structured JSON-serializable objects.
- Use `ok: false`, `code`, and `message` for recoverable errors.
- Return screenshot paths as strings, never embedded image content.
- Keep dangerous operations out of the public tool surface.

## Current adapters

### macOS: Peekaboo

The macOS adapter shells out to `peekaboo`. It assumes the user installed the
Peekaboo CLI and granted Screen Recording / Accessibility permissions.

### Windows: Windows-MCP

The Windows adapter launches a Windows-MCP stdio MCP server and forwards calls
to its desktop tools. The default command can be overridden with
`MIMO_COMPUTER_USE_WINDOWS_MCP_CMD`.

### Shared: Trope CUA

The Trope adapter is opt-in via `MIMO_COMPUTER_USE_BACKEND=trope`. It launches a
Trope CUA MCP server and forwards calls to common tool names.

## Future work

- Add backend-specific tool discovery and smarter name/argument mapping.
- Add optional OCR pass for screenshot paths using mimo2codex `mimoskill`.
- Add a small admin/doctor UI for dependency and permission checks.
