import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { platform as nodePlatform } from "node:process";
import { commandExists, runCommand } from "./shell.mjs";

// Trope CUA is the single backend, distributed as SOURCE (no package-manager
// one-liner). Install = clone the repo, then run the platform build/install
// script. Supported on macOS and Windows only.
//   https://github.com/voctory/trope-cua
const REPO = "https://github.com/voctory/trope-cua";

// Trope's global.json pins the .NET SDK to 10.0.x (rollForward: latestFeature),
// so on Windows the build needs a .NET 10 SDK. Kept as one constant so the
// prerequisite check and the user-facing prerequisite strings never drift.
const REQUIRED_DOTNET_MAJOR = 10;

function detectCmd(env = process.env) {
  return env.MIMO_COMPUTER_USE_TROPE_CMD || "trope-cua";
}

// Locate a usable `dotnet` the way trope's install-common.ps1 does: prefer
// DOTNET_ROOT, then %USERPROFILE%\.dotnet, then PATH. Returns the command/path
// to invoke, or null when none is found.
async function resolveDotnetCmd(env = process.env, has = commandExists) {
  const candidates = [];
  if (env.DOTNET_ROOT) candidates.push(path.join(env.DOTNET_ROOT, "dotnet.exe"));
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, ".dotnet", "dotnet.exe"));
  candidates.push("dotnet");
  for (const c of candidates) {
    if (await has(c)) return c;
  }
  return null;
}

// Parse `dotnet --list-sdks` into the set of installed SDK major versions.
// Returns [] when the probe couldn't run (we then defer to the build rather than
// block install on a flaky probe).
async function listDotnetSdkMajors(dotnetCmd, run = runCommand) {
  const res = await run(dotnetCmd, ["--list-sdks"], { timeoutMs: 15_000 });
  if (!res.ok) return [];
  const majors = new Set();
  for (const line of (res.stdout ?? "").split(/\r?\n/)) {
    const m = /^(\d+)\.\d+\.\d+/.exec(line.trim());
    if (m) majors.add(Number(m[1]));
  }
  return [...majors];
}

// Pre-flight dependency check, run BEFORE we clone/build, so a missing toolchain
// fails fast with an actionable message instead of a cryptic mid-build error.
// Probes are injectable for testing. Returns { ok, missing: [{name,detail,fix}] }.
export async function checkPrerequisites(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? nodePlatform;
  const has = opts.commandExists ?? commandExists;
  const run = opts.runCommand ?? runCommand;
  const requiredMajor = opts.requiredDotnetMajor ?? REQUIRED_DOTNET_MAJOR;
  const missing = [];

  if (!(await has("git"))) {
    missing.push({
      name: "git",
      detail: "git was not found on PATH.",
      fix: "Install Git (https://git-scm.com/download/win) and reopen the app, then click Reinstall.",
    });
  }

  // Only Windows builds from a .NET SDK; macOS uses Xcode CLT (checked by the
  // build script itself, since CLT detection requires xcode-select).
  if (platform === "win32") {
    const dnLabel = `.NET ${requiredMajor} SDK`;
    const dnUrl = `https://dotnet.microsoft.com/download/dotnet/${requiredMajor}.0`;
    const dotnet = await resolveDotnetCmd(env, has);
    if (!dotnet) {
      missing.push({
        name: dnLabel,
        detail: "dotnet was not found on PATH, DOTNET_ROOT, or %USERPROFILE%\\.dotnet.",
        fix: `Install the ${dnLabel} (${dnUrl}), then reopen the app and click Reinstall.`,
      });
    } else {
      const majors = await listDotnetSdkMajors(dotnet, run);
      if (majors.length > 0 && !majors.includes(requiredMajor)) {
        missing.push({
          name: dnLabel,
          detail: `Found .NET SDK major version(s) ${majors.join(", ")} but not ${requiredMajor}.x.`,
          fix: `Install the ${dnLabel} (${dnUrl}). Existing SDKs are left untouched.`,
        });
      }
      // majors.length === 0 → couldn't enumerate; let the build surface it.
    }
  }

  return { ok: missing.length === 0, missing, platform };
}

// Safety guard for uninstall: every directory we delete MUST be one of Trope
// CUA's own locations (the cloned source, our managed bin dir, or the legacy
// Windows install dir) or live under the adapters base. This makes it
// structurally impossible to remove the user's system/user .NET SDK or any
// unrelated folder, no matter what a path resolves to.
export function assertRemovableTropeDir(dir, env = process.env, platform = nodePlatform) {
  const base = env.MIMO2CODEX_ADAPTERS_DIR || path.join(os.homedir(), ".mimo2codex", "adapters");
  const norm = (p) => path.resolve(p).toLowerCase();
  const allowedExact = new Set([
    norm(path.join(base, "trope-cua")),
    norm(path.join(base, "trope-cua-bin")),
    norm(windowsInstallDir(env)),
  ]);
  const full = norm(dir);
  const withinBase = full.startsWith(norm(base) + path.sep);
  if (allowedExact.has(full) || withinBase) return path.resolve(dir);
  throw new Error(`refusing to remove non-Trope path during uninstall: ${dir}`);
}

// Stop any running Trope CUA process before wiping/installing/uninstalling.
// A lingering `serve` daemon (often launched as `dotnet trope-cua.dll serve`,
// so it shows up under the `dotnet` process name) keeps file handles open and
// makes clone/rm/copy fail with EBUSY / "folder in use". We target the actual
// binary in the command line, not our install scripts.
async function stopRunningTropeProcesses(onData, platform = nodePlatform) {
  if (platform !== "win32") return; // macOS daemon handling is out of scope here
  onData?.("progress: stopping any running Trope CUA processes...\n");
  const ps =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'trope-cua\\.(dll|exe)' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }";
  await runCommand("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    timeoutMs: 60_000,
    onData,
  });
}

// Base dir for adapter source + builds. Follows mimo2codex's (possibly
// migrated) data dir when the parent passes MIMO2CODEX_ADAPTERS_DIR; otherwise
// defaults to ~/.mimo2codex/adapters.
function adaptersBase() {
  return process.env.MIMO2CODEX_ADAPTERS_DIR || path.join(os.homedir(), ".mimo2codex", "adapters");
}

// Stable, writable cache for the cloned source so repeated installs reuse it.
function sourceDir() {
  return path.join(adaptersBase(), "trope-cua");
}

// We install Trope CUA's built binary INTO mimo2codex's own storage rather than
// the global %LOCALAPPDATA%\Programs\TropeCUA, so everything lives under the
// data dir and uninstall stays self-contained.
function installBinDir() {
  return path.join(adaptersBase(), "trope-cua-bin");
}

// The legacy/default location install-windows.ps1 uses when no -InstallDir is
// passed. Kept so uninstall can also clean up older installs.
function windowsInstallDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Programs", "TropeCUA");
}

// The binary in mimo2codex's OWN install dir — the only thing that counts as a
// successful (re)install. Never falls back to an external/legacy path, so a
// failed build can't masquerade as success and pin config to a stale exe.
function managedInstalledExe(platform = nodePlatform) {
  if (platform === "win32") {
    const p = path.join(installBinDir(), "trope-cua.exe");
    return existsSync(p) ? p : null;
  }
  return null; // macOS installs onto PATH, not a fixed path we manage
}

// Best-effort locate of the installed trope-cua executable so we can verify the
// build flavor and write it into config. Prefers the mimo2codex-owned dir, then
// an explicit MIMO_COMPUTER_USE_TROPE_CMD, then the legacy global location.
function resolveInstalledExe(env = process.env, platform = nodePlatform) {
  if (platform === "win32") {
    const inMimo = path.join(installBinDir(), "trope-cua.exe");
    if (existsSync(inMimo)) return inMimo;
  }
  const cmd = env.MIMO_COMPUTER_USE_TROPE_CMD;
  if (cmd && (cmd.includes("/") || cmd.includes("\\")) && existsSync(cmd)) return cmd;
  if (platform === "win32") {
    const legacy = path.join(windowsInstallDir(env), "trope-cua.exe");
    if (existsSync(legacy)) return legacy;
  }
  return null; // macOS install location is not a fixed path we can assume
}

// Self-contained builds embed the runtime (`includedFrameworks`); framework-
// dependent ones list `frameworks` and need .NET installed system-wide — the
// exact trap that produces "needs .NET 10 but only 8" at launch.
// Returns true (self-contained), false (framework-dependent), or null (unknown).
function checkSelfContained(exePath) {
  try {
    const cfgPath = exePath.replace(/\.exe$/i, "") + ".runtimeconfig.json";
    const json = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const ro = json?.runtimeOptions ?? {};
    if (Array.isArray(ro.includedFrameworks) && ro.includedFrameworks.length > 0) return true;
    if (Array.isArray(ro.frameworks) && ro.frameworks.length > 0) return false;
    return null;
  } catch {
    return null;
  }
}

// Returns the platform build/install invocation, or null on unsupported OS.
function platformInstaller(platform) {
  if (platform === "darwin") {
    return {
      cmd: "bash",
      args: ["scripts/install-macos.sh"],
      prerequisites: [
        "git",
        "Xcode Command Line Tools",
        "Accessibility + Screen Recording permissions for TropeCUA.app",
      ],
    };
  }
  if (platform === "win32") {
    // We do NOT use trope's scripts\install-windows.ps1 / build.ps1: their
    // `dotnet publish ... --self-contained:$sc` (colon form) is misparsed by the
    // .NET 10 SDK as RuntimeIdentifier "-Configuration" and fails. Instead we
    // reuse only trope's SDK/RID resolution and run a clean publish ourselves,
    // straight into mimo2codex's managed dir (self-contained, no PATH changes).
    const out = installBinDir();
    const script = [
      "$ErrorActionPreference='Stop'",
      "$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'",
      "$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'",
      ". .\\scripts\\install-common.ps1",
      "$rid = Get-TropeCuaDefaultRuntime",
      "$dn = Resolve-TropeCuaDotnet -Root (Get-Location).Path",
      `& $dn publish .\\src\\CuaDriver.Win\\CuaDriver.Win.csproj -c Release -r $rid --self-contained true -p:RestoreLockedMode=false -o '${out}'`,
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    ].join("; ");
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      prerequisites: ["git", "PowerShell", `.NET ${REQUIRED_DOTNET_MAJOR} SDK matching global.json`],
    };
  }
  return null;
}

export function adapterInstallPlan(env = process.env, platform = nodePlatform) {
  const installer = platformInstaller(platform);
  if (!installer) {
    return {
      ok: false,
      backend: "trope-cua",
      platform,
      autoInstall: false,
      code: "unsupported_platform",
      docs: REPO,
      message: "Trope CUA supports macOS and Windows only.",
    };
  }
  const dir = sourceDir();
  return {
    ok: true,
    backend: "trope-cua",
    platform,
    autoInstall: true,
    repo: REPO,
    docs: REPO,
    detects: [detectCmd(env)],
    sourceDir: dir,
    prerequisites: installer.prerequisites,
    steps: [
      `git clone --depth 1 ${REPO} "${dir}"`,
      platform === "win32"
        ? `dotnet publish src\\CuaDriver.Win\\CuaDriver.Win.csproj -c Release -r <rid> --self-contained true -o "${installBinDir()}"   (cwd: ${dir})`
        : `${installer.cmd} ${installer.args.join(" ")}   (cwd: ${dir})`,
    ],
    message:
      platform === "win32"
        ? "Trope CUA builds from source: clone the repo, then run scripts\\install-windows.ps1 -SelfContained. Requires git + .NET SDK."
        : "Trope CUA builds from source: clone the repo, then run scripts/install-macos.sh. Requires git + Xcode Command Line Tools; grant Accessibility/Screen Recording afterward.",
  };
}

export async function installAdapter(args = {}, env = process.env, platform = nodePlatform) {
  const plan = adapterInstallPlan(env, platform);
  if (args.dry_run === true || plan.ok === false) {
    return { ...plan, dryRun: args.dry_run === true };
  }

  if (args.confirm_install !== true) {
    return {
      ok: false,
      code: "confirmation_required",
      plan,
      message:
        "Adapter installation downloads and builds third-party software (Trope CUA). Explain the plan to the user first, then call again with confirm_install=true.",
    };
  }

  const detect = detectCmd(env);
  // `force` (admin "Reinstall" / explicit CLI install) always rebuilds; the
  // MCP `computer_install_adapter` tool keeps the fast skip-if-present path.
  if (!args.force && resolveInstalledExe(env, platform)) {
    return {
      ok: true,
      backend: "trope-cua",
      alreadyInstalled: true,
      installedExe: resolveInstalledExe(env, platform),
      message: "Trope CUA is already installed.",
    };
  }

  const installer = platformInstaller(platform);
  const timeoutMs = args.timeout_ms ?? 20 * 60 * 1000;
  const dir = sourceDir();
  const startedAt = Date.now();
  const logs = [];
  // Live output sink: when provided (CLI / admin streaming), forward child
  // stdout/stderr as it arrives so the build doesn't look frozen for minutes.
  const onData = typeof args.onProgress === "function" ? args.onProgress : undefined;

  // 0a) Pre-flight dependency check BEFORE we clone/build. A missing git or
  // .NET 10 SDK now fails fast with an actionable message instead of cloning
  // megabytes of source only to die mid-build with a cryptic error.
  onData?.("progress: checking prerequisites (git, .NET SDK)...\n");
  const prereq = await checkPrerequisites({ env, platform });
  logs.push({ step: "prerequisites", ok: prereq.ok, missing: prereq.missing });
  if (!prereq.ok) {
    const summary = prereq.missing.map((m) => `  - ${m.name}: ${m.detail} ${m.fix}`).join("\n");
    onData?.(`progress: missing prerequisites:\n${summary}\n`);
    return {
      ok: false,
      backend: "trope-cua",
      code: "prerequisites_missing",
      missing: prereq.missing,
      plan,
      logs,
      message: `Cannot install Trope CUA — missing prerequisites:\n${summary}`,
    };
  }

  // 0b) Stop any running daemon so it can't lock the source/output dirs.
  await stopRunningTropeProcesses(onData, platform);

  // 1) Fetch source. Recover from a stale/partial leftover dir (exists but not
  // a git repo → `git clone` would fatal on a non-empty target) by wiping it,
  // and from a broken checkout by re-cloning if `pull` fails.
  onData?.("progress: fetching Trope CUA source...\n");
  const wipe = (reason) => {
    onData?.(`progress: ${reason}, re-cloning fresh...\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort; clone below will surface a clear error if it's still there */
    }
  };
  let fetch;
  if (existsSync(path.join(dir, ".git"))) {
    fetch = await runCommand("git", ["-C", dir, "pull", "--ff-only"], { timeoutMs, onData });
    if (!fetch.ok) {
      wipe("pull failed");
      fetch = await runCommand("git", ["clone", "--depth", "1", REPO, dir], { timeoutMs, onData });
    }
  } else {
    if (existsSync(dir)) wipe("stale non-git source dir");
    fetch = await runCommand("git", ["clone", "--depth", "1", REPO, dir], { timeoutMs, onData });
  }
  logs.push({
    step: "fetch-source",
    ok: fetch.ok,
    exitCode: fetch.exitCode,
    stderr: fetch.stderr.trim().slice(-2000),
  });
  if (!fetch.ok) {
    return {
      ok: false,
      backend: "trope-cua",
      code: "clone_failed",
      repo: REPO,
      duration_ms: Date.now() - startedAt,
      logs,
      message: `Failed to fetch Trope CUA source from ${REPO}. Check network access and git, then retry.`,
    };
  }

  // 2) Build + install via the platform script (cwd = repo root).
  onData?.("progress: building Trope CUA (this can take several minutes)...\n");
  const build = await runCommand(installer.cmd, installer.args, { timeoutMs, cwd: dir, onData });
  logs.push({
    step: "build-install",
    ok: build.ok,
    exitCode: build.exitCode,
    timedOut: build.timedOut,
    stdout: build.stdout.trim().slice(-2000),
    stderr: build.stderr.trim().slice(-2000),
  });

  // 3) Verify the produced binary is self-contained. A framework-dependent
  // build launches fine on the build box but fails for Codex with
  // "needs .NET 10" when the matching desktop runtime isn't installed.
  //
  // Only the binary we built into our managed dir counts (on Windows); never
  // fall back to a pre-existing external exe, or a failed build would look like
  // success and re-pin config to a stale path.
  const managedExe = managedInstalledExe(platform);
  const detected = managedExe ? true : platform !== "win32" ? await commandExists(detect) : false;
  const installedExe = managedExe; // only auto-write config for our managed install
  const selfContained = managedExe ? checkSelfContained(managedExe) : null;
  if (selfContained === false) {
    onData?.("progress: WARNING built framework-dependent, not self-contained\n");
  }
  logs.push({ step: "verify", installedExe, selfContained });

  let message;
  if (build.ok && detected && selfContained === false) {
    message =
      "Trope CUA built but is framework-dependent — it needs the .NET 10 Desktop Runtime installed, " +
      "which can cause a 'needs .NET 10' error in Codex. Reinstall to rebuild self-contained, or install the .NET 10 Desktop Runtime.";
  } else if (detected) {
    message =
      "Trope CUA installed. Grant the OS permissions it requests (macOS: Accessibility + Screen Recording), then restart Codex.";
  } else if (build.ok) {
    message = `Build finished but \`${detect}\` is not on PATH yet. Restart your terminal/Codex, or set MIMO_COMPUTER_USE_TROPE_CMD to the full path of the installed trope-cua executable.`;
  } else {
    message = `Trope CUA build failed — ${platform === "win32" ? ".NET 10 SDK" : "Xcode Command Line Tools"} is likely missing. See logs and ${REPO}.`;
  }

  return {
    ok: build.ok && detected,
    backend: "trope-cua",
    repo: REPO,
    sourceDir: dir,
    installedExe,
    selfContained,
    duration_ms: Date.now() - startedAt,
    logs,
    message,
  };
}

// Fully remove the Trope CUA adapter. On Windows we prefer the upstream
// scripts/uninstall.ps1 (removes the install dir AND cleans user PATH); if the
// cloned source is gone we fall back to deleting the install dir + PATH entry
// ourselves. The cloned source cache is also removed so a later install
// re-clones cleanly.
export async function uninstallAdapter(args = {}, env = process.env, platform = nodePlatform) {
  const onData = typeof args.onProgress === "function" ? args.onProgress : undefined;
  const timeoutMs = args.timeout_ms ?? 5 * 60 * 1000;
  const startedAt = Date.now();
  const logs = [];
  const detect = detectCmd(env);
  const src = sourceDir();

  if (platform !== "win32" && platform !== "darwin") {
    return {
      ok: false,
      backend: "trope-cua",
      platform,
      code: "unsupported_platform",
      message: "Trope CUA uninstall supports macOS and Windows only.",
    };
  }

  if (platform === "win32") {
    // Stop daemons first so their file handles don't block removal.
    await stopRunningTropeProcesses(onData, platform);
    // Remove both the mimo2codex-owned install and any legacy global install.
    const dirs = [installBinDir(), windowsInstallDir(env)];
    const uninstallScript = path.join(src, "scripts", "uninstall.ps1");
    for (const dir of dirs) {
      // Safety: only ever delete a Trope CUA-owned dir. This guard makes it
      // impossible to remove the user's .NET SDK/runtime even if a path is
      // somehow misconfigured upstream.
      try {
        assertRemovableTropeDir(dir, env, platform);
      } catch (e) {
        onData?.(`progress: SKIP ${dir} (safety guard): ${e.message}\n`);
        logs.push({ step: "skip-unsafe", dir, ok: false, error: e.message });
        continue;
      }
      if (existsSync(uninstallScript)) {
        onData?.(`progress: uninstalling ${dir} via uninstall.ps1...\n`);
        const res = await runCommand(
          "powershell",
          ["-ExecutionPolicy", "Bypass", "-File", uninstallScript, "-InstallDir", dir],
          { timeoutMs, cwd: src, onData }
        );
        logs.push({ step: "uninstall-script", dir, ok: res.ok, exitCode: res.exitCode, stderr: res.stderr.trim().slice(-1000) });
      } else {
        // Fallback: remove the install dir, then strip it from user PATH.
        onData?.(`progress: removing ${dir}...\n`);
        try {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          logs.push({ step: "remove-install-dir", dir, ok: true });
        } catch (e) {
          logs.push({ step: "remove-install-dir", dir, ok: false, error: e.message });
        }
        const ps = `$d=${JSON.stringify(dir)}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p) { $n=($p -split ';' | Where-Object { $_ -and $_ -ne $d }) -join ';'; [Environment]::SetEnvironmentVariable('Path',$n,'User') }`;
        const res = await runCommand("powershell", ["-ExecutionPolicy", "Bypass", "-Command", ps], { timeoutMs, onData });
        logs.push({ step: "clean-path", dir, ok: res.ok, exitCode: res.exitCode, stderr: res.stderr.trim().slice(-1000) });
      }
    }
  } else {
    // macOS: no upstream uninstall script; best-effort removal of the source
    // cache. The app bundle / binary location varies, so tell the user.
    onData?.("progress: macOS has no automated uninstall; removing source cache only\n");
    logs.push({ step: "macos-note", ok: true });
  }

  // Drop the cloned source cache so the next install re-clones fresh.
  // Guarded by the same allowlist so we can never wipe a non-Trope folder.
  if (existsSync(src)) {
    try {
      assertRemovableTropeDir(src, env, platform);
      rmSync(src, { recursive: true, force: true });
      logs.push({ step: "remove-source", ok: true, dir: src });
    } catch (e) {
      logs.push({ step: "remove-source", ok: false, dir: src, error: e.message });
    }
  }

  // Success means WE removed our managed installs — not "no trope-cua exists
  // anywhere". A user's manual clone/build (e.g. via MIMO_COMPUTER_USE_TROPE_CMD)
  // lives outside our storage; we don't delete arbitrary user dirs, but we must
  // still report success so the caller clears the pinned config path. Otherwise
  // uninstall looks like a no-op because detection keeps finding that exe.
  const managedDirs = [installBinDir(), windowsInstallDir(env)].map((d) => d.toLowerCase());
  const stillResolvable = await commandExists(detect);
  const external =
    stillResolvable &&
    detect !== "trope-cua" &&
    !managedDirs.some((d) => detect.toLowerCase().startsWith(d));
  return {
    ok: true,
    backend: "trope-cua",
    platform,
    duration_ms: Date.now() - startedAt,
    logs,
    externalLeftover: external ? detect : null,
    message: external
      ? `Removed mimo2codex-managed installs (your system .NET is untouched) and will clear the config path. A separate Trope CUA build still exists at ${detect} (e.g. a manual clone) — delete that folder yourself if you don't want it.`
      : "Trope CUA uninstalled (only Trope CUA's own files were removed — your system .NET is untouched). Restart your terminal/Codex so the PATH change takes effect.",
  };
}
