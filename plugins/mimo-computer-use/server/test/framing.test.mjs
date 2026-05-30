import test from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, MessageReader } from "../lib/framing.mjs";

test("framing round-trips Content-Length MCP messages", () => {
  const seen = [];
  const reader = new MessageReader((m) => seen.push(m));
  reader.push(encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.deepEqual(seen, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("reader also accepts newline-delimited JSON for local smoke tests", () => {
  const seen = [];
  const reader = new MessageReader((m) => seen.push(m));
  reader.push(Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'));
  assert.equal(seen[0].method, "tools/list");
});
