import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stderr } from "node:process";
import { pluginNodeModules, overlayMainPath } from "./paths.mjs";

// Manages the optional Electron overlay child process that draws the glowing
// cursor on the REAL desktop. Electron is heavy and only installed when the
// user opts in (admin "download" button), so everything here degrades to a
// no-op when it's absent — the nut.js cursor still moves, just without the glow.

let child = null;
let unavailableReason = null;
// Set by the overlay's Stop pill / global hotkey (events arrive on the child's
// stdout). While true, tools.mjs refuses action tools so the user can grab the
// mouse back. Cleared by Resume.
let stopped = false;
let stdoutBuf = "";

export function isStopped() {
  return stopped;
}
export function resetStop() {
  stopped = false;
}

// `require('electron')` returns the absolute path to the prebuilt binary by
// reading node_modules/electron/path.txt + dist/. We resolve it the same way so
// we can spawn it with shell:false (avoids .cmd-on-Windows shell quirks).
export function electronBinaryPath() {
  const base = path.join(pluginNodeModules(), "electron");
  const pathTxt = path.join(base, "path.txt");
  if (!existsSync(pathTxt)) return null;
  try {
    const rel = readFileSync(pathTxt, "utf8").trim();
    const exe = path.join(base, "dist", rel);
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

export function electronAvailable() {
  return electronBinaryPath() !== null;
}

function ensureStarted() {
  if (child && !child.killed) return true;
  const exe = electronBinaryPath();
  if (!exe) {
    unavailableReason = "electron_not_installed";
    return false;
  }
  const main = overlayMainPath();
  if (!existsSync(main)) {
    unavailableReason = "overlay_main_missing";
    return false;
  }
  try {
    child = spawn(exe, [main], {
      // stdout carries Stop/Resume control events back from the pill/hotkey.
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      windowsHide: true,
    });
    stopped = false;
    stdoutBuf = "";
    child.on("error", (err) => {
      stderr.write(`computer-use overlay: spawn error ${err.message}\n`);
      child = null;
    });
    child.on("exit", () => {
      child = null;
    });
    child.stdout?.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === "stop") stopped = true;
          else if (msg.event === "resume") stopped = false;
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr?.on("data", (d) => stderr.write(`overlay: ${d}`));
    unavailableReason = null;
    return true;
  } catch (e) {
    unavailableReason = `spawn_failed: ${e?.message ?? e}`;
    child = null;
    return false;
  }
}

// Send one frame of overlay state. `event` is the same shape we POST to the
// proxy ({type:'click'|'move'|'state'|'type'|'scroll'|'key', x, y, scale, …}).
// The overlay process eases its cursor toward (x,y) and draws a ripple on click.
export function sendOverlay(event) {
  // Warm up the transparent window on ANY action (incl. 'state') so the first
  // click doesn't pay Electron's cold-start; only actually draw when we have
  // coordinates (or are hiding).
  if (!ensureStarted()) return;
  const hasXY = Number.isFinite(event?.x) && Number.isFinite(event?.y);
  if (!hasXY && event?.type !== "hide") return;
  try {
    child.stdin.write(JSON.stringify(event) + "\n");
  } catch (e) {
    stderr.write(`computer-use overlay: write failed ${e?.message ?? e}\n`);
  }
}

export function hideOverlay() {
  if (child && !child.killed) {
    try {
      child.stdin.write(JSON.stringify({ type: "hide" }) + "\n");
    } catch {
      /* ignore */
    }
  }
}

export function stopOverlay() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  child = null;
}

export function overlayStatus() {
  return {
    available: electronAvailable(),
    running: !!(child && !child.killed),
    reason: unavailableReason,
  };
}
