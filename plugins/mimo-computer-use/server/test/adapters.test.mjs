import test from "node:test";
import assert from "node:assert/strict";
import { chooseAdapter, waitMs } from "../lib/adapters.mjs";
import { tools } from "../lib/tools.mjs";
import { adapterInstallPlan, nutInstalled } from "../lib/installers.mjs";
import { matchTarget } from "../lib/ocr.mjs";
import { recordAiCursor, checkUserTakeover, rebaseline, isUserInControl } from "../lib/watch.mjs";
import {
  parseCombo,
  computerClick,
  computerType,
  computerKey,
  computerScroll,
  diagnose,
  __setNutForTests,
} from "../lib/nutjs.mjs";

// A fake nut.js so unit tests never move the real mouse. Key is a Proxy that
// returns the property name for any key (always "defined"), which is enough for
// parseCombo's lookups.
function fakeNut() {
  const calls = [];
  const Key = new Proxy({}, { get: (_t, p) => p });
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  }
  return {
    calls,
    Key,
    Point,
    Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
    straightTo: (target) => ({ straightTo: target }),
    mouse: {
      config: {},
      async move(path) {
        calls.push(["move", path]);
      },
      async click(button) {
        calls.push(["click", button]);
      },
      async doubleClick(button) {
        calls.push(["doubleClick", button]);
      },
      async scrollDown(n) {
        calls.push(["scrollDown", n]);
      },
      async scrollUp(n) {
        calls.push(["scrollUp", n]);
      },
      async scrollLeft(n) {
        calls.push(["scrollLeft", n]);
      },
      async scrollRight(n) {
        calls.push(["scrollRight", n]);
      },
    },
    keyboard: {
      config: {},
      async type(text) {
        calls.push(["type", text]);
      },
      async pressKey(...keys) {
        calls.push(["pressKey", keys]);
      },
      async releaseKey(...keys) {
        calls.push(["releaseKey", keys]);
      },
    },
    screen: {
      async width() {
        return 1920;
      },
      async height() {
        return 1080;
      },
    },
    FileType: { PNG: "png" },
  };
}

test("chooseAdapter resolves to the nut.js backend", () => {
  assert.equal(chooseAdapter().name, "nutjs");
});

test("tool list exposes the stable computer-use surface plus installer", () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "computer_state",
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_wait",
      "computer_install_adapter",
    ]
  );
});

test("wait is capped and returns a structured payload", async () => {
  const result = await waitMs(1);
  assert.equal(result.ok, true);
  assert.equal(result.backend, "internal");
  assert.equal(result.waited_ms, 1);
});

test("adapterInstallPlan describes a pure-Node npm install (no clone/compile)", () => {
  const plan = adapterInstallPlan();
  assert.equal(plan.backend, "nutjs");
  assert.equal(plan.ok, true);
  assert.equal(plan.autoInstall, true);
  assert.ok(Array.isArray(plan.steps) && plan.steps.length >= 1);
  assert.ok(plan.prerequisites.some((p) => /npm/i.test(p)));
  // No Trope/.NET/Xcode anywhere in the plan anymore.
  assert.ok(!JSON.stringify(plan).match(/trope|\.NET|xcode/i));
});

test("nutInstalled returns a boolean without throwing", () => {
  assert.equal(typeof nutInstalled(), "boolean");
});

test("diagnose reports missing when nut.js is not importable", async () => {
  __setNutForTests(null);
  const d = await diagnose();
  assert.equal(d.ok, false);
  assert.equal(d.code, "adapter_missing");
});

test("diagnose is ok when nut.js loads", async () => {
  __setNutForTests(fakeNut());
  const d = await diagnose();
  assert.equal(d.ok, true);
  assert.equal(d.backend, "nutjs");
});

// --- key combo parsing ------------------------------------------------------

test("parseCombo splits modifiers from the final key", () => {
  const Key = new Proxy({}, { get: (_t, p) => p });
  assert.deepEqual(parseCombo("Ctrl+C", Key), { mods: ["LeftControl"], key: "C" });
  assert.deepEqual(parseCombo("Cmd+Shift+P", Key), { mods: ["LeftSuper", "LeftShift"], key: "P" });
  assert.deepEqual(parseCombo("Alt+Tab", Key), { mods: ["LeftAlt"], key: "Tab" });
  assert.deepEqual(parseCombo("Enter", Key), { mods: [], key: "Enter" });
  assert.deepEqual(parseCombo("F5", Key), { mods: [], key: "F5" });
});

test("parseCombo yields no key for an unrecognized token", () => {
  const Key = new Proxy({}, { get: (_t, p) => p });
  assert.deepEqual(parseCombo("f99", Key), { mods: [], key: null });
});

// --- actions via the fake backend -------------------------------------------

test("computerClick moves then clicks at the given coordinates", async () => {
  const nut = fakeNut();
  __setNutForTests(nut);
  const r = await computerClick({ x: 100, y: 200 });
  assert.equal(r.ok, true);
  assert.equal(r.x, 100);
  assert.equal(r.y, 200);
  assert.equal(r.via, "coordinates");
  assert.deepEqual(nut.calls.map((c) => c[0]), ["move", "click"]);
  const moved = nut.calls[0][1].straightTo;
  assert.equal(moved.x, 100);
  assert.equal(moved.y, 200);
});

test("computerClick supports right + double click", async () => {
  const nut = fakeNut();
  __setNutForTests(nut);
  await computerClick({ x: 1, y: 1, button: "right", double: true });
  assert.deepEqual(nut.calls.map((c) => c[0]), ["move", "doubleClick"]);
  assert.equal(nut.calls[1][1], "right");
});

test("computerClick errors with no coordinates and no target", async () => {
  __setNutForTests(fakeNut());
  const r = await computerClick({});
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_target");
});

test("computerType types the text", async () => {
  const nut = fakeNut();
  __setNutForTests(nut);
  const r = await computerType({ text: "hello" });
  assert.equal(r.ok, true);
  assert.deepEqual(nut.calls.at(-1), ["type", "hello"]);
});

test("computerKey presses and releases the parsed sequence", async () => {
  const nut = fakeNut();
  __setNutForTests(nut);
  const r = await computerKey({ key: "Ctrl+C" });
  assert.equal(r.ok, true);
  assert.deepEqual(nut.calls[0], ["pressKey", ["LeftControl", "C"]]);
  assert.deepEqual(nut.calls[1], ["releaseKey", ["C", "LeftControl"]]);
});

test("computerScroll scrolls in the requested direction", async () => {
  const nut = fakeNut();
  __setNutForTests(nut);
  await computerScroll({ direction: "up", amount: 5 });
  assert.deepEqual(nut.calls.at(-1), ["scrollUp", 5]);
});

// --- OCR target matching ----------------------------------------------------

test("matchTarget prefers exact, then substring, then word-set", () => {
  const targets = [
    { text: "Submit", cx: 10, cy: 10 },
    { text: "Submit form now", cx: 20, cy: 20 },
    { text: "Cancel", cx: 30, cy: 30 },
  ];
  assert.equal(matchTarget(targets, "Submit").cx, 10); // exact
  assert.equal(matchTarget(targets, "cancel").text, "Cancel"); // case-insensitive exact
  assert.equal(matchTarget(targets, "now").text, "Submit form now"); // substring
  assert.equal(matchTarget(targets, "missing"), null);
});

// --- human-takeover watch ---------------------------------------------------

test("watch detects user mouse takeover and clears on rebaseline", async () => {
  const fake = { state: { pos: { x: 0, y: 0 } }, mouse: { async getPosition() { return fake.state.pos; } } };
  __setNutForTests(fake);

  recordAiCursor(100, 100); // AI left the cursor here
  fake.state.pos = { x: 100, y: 100 };
  assert.equal(await checkUserTakeover(), null); // cursor unchanged → no takeover

  fake.state.pos = { x: 300, y: 305 }; // user grabbed the mouse
  const t = await checkUserTakeover();
  assert.ok(t && t.to.x === 300 && t.to.y === 305);
  assert.equal(isUserInControl(), true);

  await rebaseline(); // AI re-observes via computer_state
  assert.equal(isUserInControl(), false);
  assert.equal(await checkUserTakeover(), null); // baseline is now (300,305)
});
