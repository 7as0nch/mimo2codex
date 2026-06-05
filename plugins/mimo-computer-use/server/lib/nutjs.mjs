import { readSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { platform } from "node:process";
import { framesDir } from "./paths.mjs";
import { ocrBoxes, matchTarget } from "./ocr.mjs";

// Pure nut.js executor — the ONLY backend (replaces the old Trope CUA forwarder).
// nut.js ships prebuilt native bindings via npm, so there is no compiler /
// Xcode / .NET toolchain to install: `npm install` in the plugin is enough.
//
// This module is side-effect-free (no overlay / event emission) so it stays
// unit-testable with an injected fake nut module; the live emission happens in
// tools.mjs around these calls.

let nutPromise = null;
let frameSeq = 0;

// nut.js is installed lazily (it's a plugin-local dependency that may not be
// present until the admin "install" step runs). Cache the import; null = not
// installed yet.
async function loadNut() {
  if (!nutPromise) {
    nutPromise = import("@nut-tree-fork/nut-js").catch(() => null);
  }
  return nutPromise;
}

// Test seam: let adapters.test.mjs inject a fake nut module.
export function __setNutForTests(fake) {
  nutPromise = Promise.resolve(fake);
}

// jimp is an optional, pure-JS image library (no native build) used to
// downscale embedded screenshots so vision models don't blow up the session
// history. Best-effort: if it isn't installed we fall back to the raw PNG.
let jimpPromise = null;
async function loadJimp() {
  if (!jimpPromise) {
    jimpPromise = import("jimp")
      .then((m) => m.Jimp ?? m.default ?? m)
      .catch(() => null);
  }
  return jimpPromise;
}

// Downscale `file` to a JPEG and return base64. Tolerates both jimp v1
// (resize({w}), getBuffer("image/jpeg")) and v0 (resize(w, AUTO), quality(),
// getBufferAsync(MIME_JPEG)). Returns null if it can't.
async function downscaleToJpegBase64(Jimp, file, maxW, quality) {
  const img = await Jimp.read(file);
  const w = img.bitmap?.width ?? img.width ?? 0;
  if (w > maxW && typeof img.resize === "function") {
    try {
      img.resize({ w: maxW }); // jimp v1
    } catch {
      try {
        img.resize(maxW, Jimp.AUTO ?? -1); // jimp v0
      } catch {
        /* keep original size */
      }
    }
  }
  if (typeof img.getBuffer === "function") {
    const buf = await img.getBuffer("image/jpeg", { quality }); // jimp v1
    return Buffer.isBuffer(buf) ? buf.toString("base64") : null;
  }
  if (typeof img.quality === "function" && typeof img.getBufferAsync === "function") {
    img.quality(quality);
    const buf = await img.getBufferAsync(Jimp.MIME_JPEG ?? "image/jpeg"); // jimp v0
    return Buffer.isBuffer(buf) ? buf.toString("base64") : null;
  }
  return null;
}

function missing() {
  return {
    ok: false,
    backend: "nutjs",
    code: "adapter_missing",
    message:
      "nut.js is not installed yet. Open the admin console → Plugins → MiMo Computer Use → " +
      "Install, or run `npm install` in plugins/mimo-computer-use.",
    install: { helper: "npm run install-adapter" },
  };
}

export async function diagnose() {
  const nut = await loadNut();
  if (!nut) return missing();
  return {
    ok: true,
    backend: "nutjs",
    platform,
    message:
      platform === "darwin"
        ? "nut.js ready. macOS needs Accessibility + Screen Recording permission for the host app (the terminal / Codex) — grant it in System Settings → Privacy & Security if clicks or screenshots fail."
        : "nut.js ready.",
  };
}

// --- screenshot helpers -----------------------------------------------------

// Read PNG pixel dimensions straight from the IHDR chunk (bytes 16-23) so we
// don't need an image library just to learn the screenshot's real size.
function pngSize(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    readSync(fd, buf, 0, 24, 0);
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    closeSync(fd);
  }
}

// --- key parsing ------------------------------------------------------------

const MOD_TOKENS = {
  ctrl: "LeftControl",
  control: "LeftControl",
  ctl: "LeftControl",
  shift: "LeftShift",
  alt: "LeftAlt",
  option: "LeftAlt",
  opt: "LeftAlt",
  cmd: "LeftSuper",
  command: "LeftSuper",
  meta: "LeftSuper",
  super: "LeftSuper",
  win: "LeftSuper",
  windows: "LeftSuper",
};

const NAMED_KEYS = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  capslock: "CapsLock",
};

// Resolve one token to a nut.js Key enum value, or null if unknown.
function tokenToKey(token, Key) {
  const t = token.trim().toLowerCase();
  if (!t) return null;
  if (NAMED_KEYS[t] && Key[NAMED_KEYS[t]] !== undefined) return Key[NAMED_KEYS[t]];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) {
    const name = "F" + t.slice(1);
    return Key[name] !== undefined ? Key[name] : null;
  }
  if (/^[a-z]$/.test(t)) return Key[t.toUpperCase()];
  if (/^[0-9]$/.test(t)) return Key["Num" + t];
  return null;
}

// Parse "Ctrl+C", "Cmd+Shift+P", "Alt+Tab", "Enter" → { mods:[Key…], key:Key }.
export function parseCombo(combo, Key) {
  const parts = String(combo)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const mods = [];
  let key = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (MOD_TOKENS[lower] && Key[MOD_TOKENS[lower]] !== undefined) {
      mods.push(Key[MOD_TOKENS[lower]]);
    } else {
      key = tokenToKey(p, Key);
    }
  }
  return { mods, key };
}

// --- actions ----------------------------------------------------------------

export async function computerState(args = {}) {
  const nut = await loadNut();
  if (!nut) return missing();
  const { screen, FileType } = nut;

  const name = `frame-${Date.now()}-${(frameSeq++).toString(36)}`;
  let savedPath;
  try {
    savedPath = await screen.capture(name, FileType.PNG, framesDir());
  } catch (e) {
    return { ok: false, backend: "nutjs", code: "capture_failed", message: `Screenshot failed: ${e?.message ?? e}` };
  }
  const logicalW = await screen.width();
  const logicalH = await screen.height();
  const phys = pngSize(savedPath);
  const scale = logicalW > 0 ? Math.round((phys.width / logicalW) * 100) / 100 || 1 : 1;
  const frameName = path.basename(savedPath);

  const screenshot = { path: savedPath, frameName, width: phys.width, height: phys.height };
  // A-perception: embed the screenshot as base64 (default ON, pass
  // include_image:false to disable). It is ALWAYS downscaled hard (≈70KB JPEG)
  // so it can't balloon the history Codex resends each turn — the full-res
  // embed used to grow the request until it failed mid-stream. The proxy only
  // forwards the image to vision-capable models (and relocates it into a user
  // message, since Chat tool messages can't carry images); for non-vision
  // models it's stripped upstream with an OCR hint.
  if (args.include_image !== false) {
    const maxW = Number.isFinite(args.image_width) ? args.image_width : 1024;
    const quality = Number.isFinite(args.image_quality) ? args.image_quality : 50;
    const Jimp = await loadJimp();
    if (Jimp) {
      try {
        const b64 = await downscaleToJpegBase64(Jimp, savedPath, maxW, quality);
        if (b64) {
          screenshot.image = b64;
          screenshot.imageMime = "image/jpeg";
        }
      } catch {
        /* fall back to raw PNG below */
      }
    }
    if (!screenshot.image) {
      // jimp unavailable/failed — only embed the raw PNG if it's already small,
      // otherwise skip it (embedding a ~1MB PNG every turn is exactly what broke
      // sessions). Keep the path + OCR targets either way.
      try {
        const bytes = statSync(savedPath).size;
        const RAW_CAP = 256 * 1024;
        if (bytes <= RAW_CAP) {
          screenshot.image = readFileSync(savedPath).toString("base64");
          screenshot.imageMime = "image/png";
        } else {
          screenshot.imageSkipped = `screenshot ${Math.round(bytes / 1024)}KB not embedded (downscaler unavailable). Install the plugin's deps (jimp), or use OCR targets / the screenshot path.`;
        }
      } catch {
        /* leave image out — path is still available */
      }
    }
  }

  const result = {
    ok: true,
    backend: "nutjs",
    size: { width: logicalW, height: logicalH },
    screenshot,
    scale,
    message:
      "Screen captured. Coordinates are in screen-mouse space (the `size` above); " +
      "the OCR `targets` below are already in that space — click them directly. " +
      (scale !== 1 ? `(The saved screenshot file is ${scale}× larger; HiDPI.)` : ""),
  };

  // C-perception (default ON): attach OCR'd text targets with click coordinates
  // so text-only models (the common MiMo case) can click by label without the
  // image. Pass ocr:false to skip. Degrades gracefully if tesseract is missing.
  if (args.ocr !== false) {
    const ocr = await ocrBoxes(savedPath, { lang: args.lang });
    if (ocr.ok) {
      // OCR boxes are in physical image pixels; map to screen-mouse space.
      result.targets = ocr.targets.map((t) => ({
        text: t.text,
        x: Math.round(t.cx / scale),
        y: Math.round(t.cy / scale),
      }));
      result.ocrEngine = ocr.engine;
    } else {
      result.ocr = { ok: false, message: ocr.message };
    }
  }

  // If the model can neither see the image nor get OCR targets, it has no
  // reliable way to choose a click point — say so instead of letting it guess.
  if (!screenshot.image && !(result.targets && result.targets.length)) {
    result.hint =
      "No screenshot image and no OCR targets are available, so coordinates can't be located reliably. " +
      "Install tesseract OCR (so this tool returns clickable `targets`), or switch to a vision model (e.g. mimo-v2.5) and call computer_state with include_image:true. " +
      "Do NOT guess x/y coordinates blindly.";
  }
  return result;
}

// Resolve a click point: explicit x/y wins; otherwise match a `target` text
// against a fresh OCR pass so text-only models can click by label.
async function resolvePoint(args) {
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
    return { x: Math.round(args.x), y: Math.round(args.y), via: "coordinates" };
  }
  if (typeof args.target === "string" && args.target.trim()) {
    const nut = await loadNut();
    const { screen, FileType } = nut;
    const name = `target-${Date.now()}`;
    const savedPath = await screen.capture(name, FileType.PNG, framesDir());
    const logicalW = await screen.width();
    const phys = pngSize(savedPath);
    const scale = logicalW > 0 ? phys.width / logicalW || 1 : 1;
    const ocr = await ocrBoxes(savedPath, { lang: args.lang });
    const hit = ocr.ok ? matchTarget(ocr.targets, args.target) : null;
    if (hit) return { x: Math.round(hit.cx / scale), y: Math.round(hit.cy / scale), via: `ocr:${hit.text}` };
    return { error: `No on-screen text matched target "${args.target}".` };
  }
  return { error: "computer_click needs x/y coordinates or a target text." };
}

export async function computerClick(args = {}) {
  const nut = await loadNut();
  if (!nut) return missing();
  const { mouse, Button, Point, straightTo } = nut;
  const point = await resolvePoint(args);
  if (point.error) return { ok: false, backend: "nutjs", code: "no_target", message: point.error };

  const button =
    args.button === "right" ? Button.RIGHT : args.button === "middle" ? Button.MIDDLE : Button.LEFT;
  try {
    mouse.config.mouseSpeed = Number.isFinite(args.speed) ? args.speed : 2200; // px/s — visible glide
    await mouse.move(straightTo(new Point(point.x, point.y)));
    if (args.double === true) await mouse.doubleClick(button);
    else await mouse.click(button);
  } catch (e) {
    return { ok: false, backend: "nutjs", code: "click_failed", message: `Click failed: ${e?.message ?? e}` };
  }
  return { ok: true, backend: "nutjs", x: point.x, y: point.y, via: point.via, button: args.button ?? "left", double: !!args.double };
}

export async function computerType(args = {}) {
  const nut = await loadNut();
  if (!nut) return missing();
  const { keyboard, Key } = nut;
  if (typeof args.text !== "string") return { ok: false, backend: "nutjs", code: "bad_args", message: "type needs `text`." };
  try {
    if (args.clear === true) {
      const mod = platform === "darwin" ? Key.LeftSuper : Key.LeftControl;
      await keyboard.pressKey(mod, Key.A);
      await keyboard.releaseKey(mod, Key.A);
      await keyboard.pressKey(Key.Delete);
      await keyboard.releaseKey(Key.Delete);
    }
    await keyboard.type(args.text);
  } catch (e) {
    return { ok: false, backend: "nutjs", code: "type_failed", message: `Type failed: ${e?.message ?? e}` };
  }
  return { ok: true, backend: "nutjs", typed: args.text.length };
}

export async function computerKey(args = {}) {
  const nut = await loadNut();
  if (!nut) return missing();
  const { keyboard, Key } = nut;
  const combo = args.key ?? args.combo;
  if (typeof combo !== "string" || !combo.trim()) {
    return { ok: false, backend: "nutjs", code: "bad_args", message: "key needs a `key`/`combo` string." };
  }
  const { mods, key } = parseCombo(combo, Key);
  if (key === null && mods.length === 0) {
    return { ok: false, backend: "nutjs", code: "unknown_key", message: `Unrecognized key/combo: "${combo}".` };
  }
  const sequence = key === null ? mods : [...mods, key];
  try {
    await keyboard.pressKey(...sequence);
    await keyboard.releaseKey(...sequence.slice().reverse());
  } catch (e) {
    return { ok: false, backend: "nutjs", code: "key_failed", message: `Key failed: ${e?.message ?? e}` };
  }
  return { ok: true, backend: "nutjs", key: combo };
}

// Current real cursor position, in screen-mouse space (same space as click
// coordinates). Used by the human-takeover watcher. Returns null if nut.js
// isn't loaded or the read fails.
export async function getCursorPos() {
  const nut = await loadNut();
  if (!nut) return null;
  try {
    const p = await nut.mouse.getPosition();
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  } catch {
    /* ignore */
  }
  return null;
}

export async function computerScroll(args = {}) {
  const nut = await loadNut();
  if (!nut) return missing();
  const { mouse, Point, straightTo } = nut;
  const amount = Number.isFinite(args.amount) ? Math.abs(args.amount) : 3;
  const dir = args.direction ?? "down";
  try {
    if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
      await mouse.move(straightTo(new Point(Math.round(args.x), Math.round(args.y))));
    }
    if (dir === "up") await mouse.scrollUp(amount);
    else if (dir === "left") await mouse.scrollLeft(amount);
    else if (dir === "right") await mouse.scrollRight(amount);
    else await mouse.scrollDown(amount);
  } catch (e) {
    return { ok: false, backend: "nutjs", code: "scroll_failed", message: `Scroll failed: ${e?.message ?? e}` };
  }
  return { ok: true, backend: "nutjs", direction: dir, amount };
}
