import test from "node:test";
import assert from "node:assert/strict";
import { chooseAdapter, waitMs } from "../lib/adapters.mjs";
import { tools } from "../lib/tools.mjs";
import { adapterInstallPlan } from "../lib/installers.mjs";

test("chooseAdapter selects platform defaults", () => {
  assert.equal(chooseAdapter({}, "darwin").name, "peekaboo");
  assert.equal(chooseAdapter({}, "win32").name, "windows-mcp");
  assert.equal(chooseAdapter({}, "linux").name, "unsupported");
});

test("chooseAdapter honors explicit backend", () => {
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "trope" }, "darwin").name, "trope-cua");
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "windows-mcp" }, "darwin").name, "windows-mcp");
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "peekaboo" }, "win32").name, "peekaboo");
});

test("tool list exposes the stable computer-use surface plus installer", () => {
  assert.deepEqual(tools.map((t) => t.name), [
    "computer_state",
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_scroll",
    "computer_wait",
    "computer_install_adapter",
  ]);
});

test("wait is capped and returns a structured payload", async () => {
  const result = await waitMs(1);
  assert.equal(result.ok, true);
  assert.equal(result.backend, "internal");
  assert.equal(result.waited_ms, 1);
});

test("adapterInstallPlan selects platform installers", () => {
  assert.deepEqual(adapterInstallPlan({}, "darwin").command, ["brew", "install", "steipete/tap/peekaboo"]);
  assert.deepEqual(adapterInstallPlan({}, "win32").command, ["uv", "tool", "install", "windows-mcp"]);
  assert.equal(adapterInstallPlan({}, "linux").code, "unsupported_platform");
});
