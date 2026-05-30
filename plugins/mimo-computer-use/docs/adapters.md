# Adapter Contract

Adapters normalize platform-specific desktop automation into six MCP tools.

## Required behavior

- Return structured JSON-serializable objects.
- Use `ok: false`, `code`, and `message` for recoverable errors.
- Return screenshot paths as strings, never embedded image content.
- Keep dangerous operations out of the public tool surface.

## Current adapter

### Cross-platform: Trope CUA

The single backend launches a [Trope CUA](https://github.com/voctory/trope-cua)
stdio MCP server (via `callExternalMcp`) and forwards the six computer-use tools
to it. It is the default on every platform; `MIMO_COMPUTER_USE_BACKEND` accepts
`auto` (default) or `trope`. The launch command/args are overridable with
`MIMO_COMPUTER_USE_TROPE_CMD` / `MIMO_COMPUTER_USE_TROPE_ARGS`.

## Future work

- Verify and refine the Trope CUA tool-name / argument mapping against upstream.
- Add optional OCR pass for screenshot paths using mimo2codex `mimoskill`.
- Add a small admin/doctor UI for dependency and permission checks.
