import test from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, MessageReader } from "../lib/framing.mjs";

test("encodeMessage emits newline-delimited JSON (MCP stdio wire format)", () => {
  const bytes = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" }).toString("utf8");
  assert.equal(bytes, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  assert.ok(!bytes.includes("Content-Length"), "must not use Content-Length framing");
});

test("framing round-trips newline-delimited MCP messages", () => {
  const seen = [];
  const reader = new MessageReader((m) => seen.push(m));
  reader.push(encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.deepEqual(seen, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
});

test("reader still accepts legacy Content-Length frames (backward compat)", () => {
  const seen = [];
  const reader = new MessageReader((m) => seen.push(m));
  const body = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
  reader.push(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf8"));
  assert.equal(seen[0].method, "tools/list");
});
