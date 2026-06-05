import { existsSync } from "node:fs";
import path from "node:path";
import { platform as nodePlatform } from "node:process";
import { runCommand } from "./shell.mjs";
import { pluginRoot, pluginNodeModules } from "./paths.mjs";
import { electronBinaryPath } from "./overlay.mjs";

// Pure-Node install: just `npm install` the plugin's own dependencies. nut.js
// ships prebuilt native bindings, so there is NO clone/compile/.NET/Xcode step
// (that was the Trope CUA pain this rewrite removed). Electron — the optional
// glowing-cursor overlay runtime — is large, so it is only installed when the
// user opts in (admin "download" / with_electron:true).

const ELECTRON_SPEC = process.env.MIMO_COMPUTER_USE_ELECTRON_SPEC || "electron";

// Run an npm command line through a shell (so the Windows `npm.cmd` shim
// resolves). We pass the WHOLE line as the command string with no separate args
// array — passing an args array with shell:true triggers Node's DEP0190 warning.
// The command lines here are fixed literals (ELECTRON_SPEC is operator config),
// so there is no untrusted-input concatenation.
function runNpm(line, { cwd, timeoutMs, onData, env }) {
  return runCommand(line, [], { cwd, shell: true, timeoutMs, onData, env });
}

// Electron's postinstall downloads a ~150MB binary from GitHub, which is
// frequently blocked/slow in mainland China — there `npm install electron` can
// exit 0 while the binary never lands (no dist/path.txt). Default to the
// npmmirror Electron mirror so the download works out of the box; honor an
// explicit ELECTRON_MIRROR if the user already set one.
function electronMirror() {
  return process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
}

export function nutInstalled() {
  return existsSync(path.join(pluginNodeModules(), "@nut-tree-fork", "nut-js"));
}

export function adapterInstallPlan() {
  return {
    ok: true,
    backend: "nutjs",
    platform: nodePlatform,
    autoInstall: true,
    prerequisites: ["Node.js ≥ 18", "npm"],
    steps: [
      `npm install                 (cwd: ${pluginRoot()})  → installs nut.js`,
      `npm install ${ELECTRON_SPEC}   (only with the glowing-cursor option) → installs Electron`,
    ],
    notes:
      nodePlatform === "darwin"
        ? "macOS: after install, grant Accessibility + Screen Recording to the host app (terminal / Codex) in System Settings → Privacy & Security."
        : "Windows: no extra build tools required.",
    message:
      "Installs the plugin's pure-Node dependencies via npm. nut.js is required; Electron is optional (glowing on-desktop cursor).",
  };
}

export async function installAdapter(args = {}) {
  const plan = adapterInstallPlan();
  if (args.dry_run === true) return { ...plan, dryRun: true };
  if (args.confirm_install !== true) {
    return {
      ok: false,
      code: "confirmation_required",
      plan,
      message: "Installation runs `npm install` (and downloads Electron when requested). Tell the user, then call again with confirm_install=true.",
    };
  }

  const timeoutMs = args.timeout_ms ?? 10 * 60 * 1000;
  const onData = typeof args.onProgress === "function" ? args.onProgress : undefined;
  const cwd = pluginRoot();
  const logs = [];
  const startedAt = Date.now();

  // Skip-if-present fast path (unless force) — but always proceed when Electron
  // is requested and not yet installed.
  const needElectron = args.with_electron === true && !electronBinaryPath();
  if (!args.force && nutInstalled() && !needElectron) {
    return { ok: true, backend: "nutjs", alreadyInstalled: true, electron: !!electronBinaryPath(), message: "nut.js already installed." };
  }

  // 1) Core deps (nut.js).
  onData?.("progress: installing nut.js (npm install)...\n");
  const core = await runNpm("npm install --no-audit --no-fund", { cwd, timeoutMs, onData });
  logs.push({ step: "npm-install", ok: core.ok, exitCode: core.exitCode, stderr: (core.stderr || "").trim().slice(-1500) });
  if (!core.ok) {
    return { ok: false, backend: "nutjs", code: "npm_install_failed", logs, duration_ms: Date.now() - startedAt, message: "`npm install` failed — check Node/npm and network, then retry." };
  }

  // 2) Optional Electron overlay runtime.
  if (args.with_electron === true) {
    const mirror = electronMirror();
    const elEnv = { ELECTRON_MIRROR: mirror };
    onData?.(`progress: installing Electron (${ELECTRON_SPEC}) via mirror ${mirror} ...\n`);
    const el = await runNpm(`npm install ${ELECTRON_SPEC} --no-audit --no-fund`, { cwd, timeoutMs, onData, env: elEnv });
    logs.push({ step: "npm-install-electron", ok: el.ok, exitCode: el.exitCode, stderr: (el.stderr || "").trim().slice(-1500) });

    // npm can report success even when the binary download was skipped/failed
    // (no dist/path.txt). Verify and, if missing, force the binary download via
    // Electron's own install.js with the mirror set.
    if (!electronBinaryPath()) {
      const installJs = path.join(pluginNodeModules(), "electron", "install.js");
      if (existsSync(installJs)) {
        onData?.("progress: Electron binary missing — fetching it via mirror (install.js)...\n");
        const dl = await runCommand(process.execPath, [installJs], { cwd, timeoutMs, onData, env: elEnv });
        logs.push({ step: "electron-binary", ok: dl.ok, exitCode: dl.exitCode, stderr: (dl.stderr || "").trim().slice(-1500) });
      }
    }

    if (!el.ok && !electronBinaryPath()) {
      return {
        ok: false,
        backend: "nutjs",
        code: "electron_install_failed",
        nutInstalled: nutInstalled(),
        electron: false,
        logs,
        duration_ms: Date.now() - startedAt,
        message: `nut.js installed, but the Electron binary download failed (often a network block). Set ELECTRON_MIRROR (tried ${mirror}) and retry. The cursor still works without the on-desktop glow.`,
      };
    }
  }

  const electron = !!electronBinaryPath();
  return {
    ok: nutInstalled(),
    backend: "nutjs",
    nutInstalled: nutInstalled(),
    electron,
    duration_ms: Date.now() - startedAt,
    logs,
    message: electron
      ? "Installed nut.js + Electron (glowing cursor enabled). Restart Codex so it reloads the plugin."
      : args.with_electron === true
        ? `Installed nut.js, but the Electron binary didn't land (network?). Retry the download, or set ELECTRON_MIRROR. Cursor still works without the desktop glow.`
        : "Installed nut.js. Restart Codex so it reloads the plugin.",
  };
}

export async function uninstallAdapter(args = {}) {
  const onData = typeof args.onProgress === "function" ? args.onProgress : undefined;
  const timeoutMs = args.timeout_ms ?? 5 * 60 * 1000;
  const cwd = pluginRoot();
  const startedAt = Date.now();
  const logs = [];

  // Only the optional Electron runtime is removed; nut.js is the core backend
  // and stays so basic computer-use keeps working.
  onData?.("progress: removing Electron overlay runtime...\n");
  const res = await runNpm("npm rm electron --no-audit --no-fund", { cwd, timeoutMs, onData });
  logs.push({ step: "npm-rm-electron", ok: res.ok, exitCode: res.exitCode, stderr: (res.stderr || "").trim().slice(-1000) });

  return {
    ok: true,
    backend: "nutjs",
    electron: !!electronBinaryPath(),
    duration_ms: Date.now() - startedAt,
    logs,
    message: "Removed the Electron overlay runtime (nut.js kept — basic computer-use still works). Restart Codex to apply.",
  };
}
