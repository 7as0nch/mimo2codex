import test from "node:test";
import assert from "node:assert/strict";
import { chooseAdapter, waitMs } from "../lib/adapters.mjs";
import { tools } from "../lib/tools.mjs";
import {
  adapterInstallPlan,
  checkPrerequisites,
  assertRemovableTropeDir,
} from "../lib/installers.mjs";

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

// --- prerequisite detection (run BEFORE clone/build) --------------------------

// Fake probes so the check never touches the real machine.
function fakeProbes({ present = [], sdks = [] } = {}) {
  return {
    commandExists: async (cmd) => present.includes(cmd),
    runCommand: async (cmd, args) => {
      if (cmd && args?.[0] === "--list-sdks") {
        return { ok: sdks.length > 0, exitCode: 0, stdout: sdks.join("\n"), stderr: "" };
      }
      return { ok: false, exitCode: 1, stdout: "", stderr: "" };
    },
  };
}

test("checkPrerequisites passes on Windows with git + a .NET 10 SDK", async () => {
  const r = await checkPrerequisites({
    env: {},
    platform: "win32",
    ...fakeProbes({ present: ["git", "dotnet"], sdks: ["10.0.201 [C:\\Program Files\\dotnet\\sdk]"] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

test("checkPrerequisites flags missing git", async () => {
  const r = await checkPrerequisites({
    env: {},
    platform: "win32",
    ...fakeProbes({ present: ["dotnet"], sdks: ["10.0.201 [x]"] }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => m.name === "git"));
});

test("checkPrerequisites flags a totally missing .NET SDK on Windows", async () => {
  const r = await checkPrerequisites({
    env: {},
    platform: "win32",
    ...fakeProbes({ present: ["git"], sdks: [] }),
  });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some((m) => /\.NET 10 SDK/.test(m.name)));
});

test("checkPrerequisites flags a wrong .NET major (8 installed, 10 needed)", async () => {
  const r = await checkPrerequisites({
    env: {},
    platform: "win32",
    ...fakeProbes({ present: ["git", "dotnet"], sdks: ["8.0.100 [x]", "9.0.100 [x]"] }),
  });
  assert.equal(r.ok, false);
  const dn = r.missing.find((m) => /\.NET 10 SDK/.test(m.name));
  assert.ok(dn && /8|9/.test(dn.detail));
});

test("checkPrerequisites on macOS only requires git (no .NET check)", async () => {
  const r = await checkPrerequisites({
    env: {},
    platform: "darwin",
    ...fakeProbes({ present: ["git"], sdks: [] }),
  });
  assert.equal(r.ok, true);
});

// --- uninstall safety guard ---------------------------------------------------

test("assertRemovableTropeDir refuses paths outside Trope storage (protects .NET)", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", MIMO2CODEX_ADAPTERS_DIR: "C:\\Users\\u\\.mimo2codex\\adapters" };
  // System / user .NET locations must NEVER be removable.
  for (const danger of [
    "C:\\Program Files\\dotnet",
    "C:\\Users\\u\\.dotnet",
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\dotnet",
  ]) {
    assert.throws(() => assertRemovableTropeDir(danger, env, "win32"), /refusing to remove/);
  }
});

test("assertRemovableTropeDir allows the managed Trope dirs", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", MIMO2CODEX_ADAPTERS_DIR: "C:\\Users\\u\\.mimo2codex\\adapters" };
  for (const ok of [
    "C:\\Users\\u\\.mimo2codex\\adapters\\trope-cua",
    "C:\\Users\\u\\.mimo2codex\\adapters\\trope-cua-bin",
    "C:\\Users\\u\\AppData\\Local\\Programs\\TropeCUA",
  ]) {
    assert.doesNotThrow(() => assertRemovableTropeDir(ok, env, "win32"));
  }
});
