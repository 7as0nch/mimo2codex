import test from "node:test";
import assert from "node:assert/strict";
import { chooseAdapter, waitMs } from "../lib/adapters.mjs";
import { tools } from "../lib/tools.mjs";
import { adapterInstallPlan } from "../lib/installers.mjs";

test("chooseAdapter resolves to Trope CUA by default (auto) and on explicit trope", () => {
  assert.equal(chooseAdapter({}).name, "trope-cua");
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "auto" }).name, "trope-cua");
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "trope" }).name, "trope-cua");
  assert.equal(chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: "TROPE" }).name, "trope-cua");
});

test("chooseAdapter rejects retired/unknown backends instead of falling back", async () => {
  for (const backend of ["peekaboo", "windows-mcp", "nonsense"]) {
    const adapter = chooseAdapter({ MIMO_COMPUTER_USE_BACKEND: backend });
    assert.equal(adapter.name, "unsupported");
    const diag = await adapter.module.diagnose();
    assert.equal(diag.ok, false);
    assert.equal(diag.code, "unsupported_backend");
  }
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

test("adapterInstallPlan builds Trope CUA from source on macOS/Windows", () => {
  for (const platform of ["darwin", "win32"]) {
    const plan = adapterInstallPlan({}, platform);
    assert.equal(plan.backend, "trope-cua");
    assert.equal(plan.ok, true);
    assert.equal(plan.autoInstall, true);
    assert.equal(plan.repo, "https://github.com/voctory/trope-cua");
    assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 2);
    assert.deepEqual(plan.detects, ["trope-cua"]);
  }
});

test("adapterInstallPlan reports unsupported platform on Linux", () => {
  const plan = adapterInstallPlan({}, "linux");
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "unsupported_platform");
});

test("install plan honors MIMO_COMPUTER_USE_TROPE_CMD for detection", () => {
  const plan = adapterInstallPlan({ MIMO_COMPUTER_USE_TROPE_CMD: "/opt/trope" }, "darwin");
  assert.deepEqual(plan.detects, ["/opt/trope"]);
});
