import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { platform as nodePlatform } from "node:process";
import { commandExists, runCommand } from "./shell.mjs";

// Trope CUA is the single backend, distributed as SOURCE (no package-manager
// one-liner). Install = clone the repo, then run the platform build/install
// script. Supported on macOS and Windows only.
//   https://github.com/voctory/trope-cua
const REPO = "https://github.com/voctory/trope-cua";

function detectCmd(env = process.env) {
  return env.MIMO_COMPUTER_USE_TROPE_CMD || "trope-cua";
}

// Stable, writable cache for the cloned source so repeated installs reuse it.
function sourceDir() {
  return path.join(os.homedir(), ".mimo2codex", "adapters", "trope-cua");
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
    return {
      cmd: "powershell",
      args: ["-ExecutionPolicy", "Bypass", "-File", "scripts\\install-windows.ps1", "-SelfContained"],
      prerequisites: ["git", "PowerShell", ".NET SDK matching global.json"],
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
      `${installer.cmd} ${installer.args.join(" ")}   (cwd: ${dir})`,
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
  if (await commandExists(detect)) {
    return {
      ok: true,
      backend: "trope-cua",
      alreadyInstalled: true,
      message: "Trope CUA is already installed.",
    };
  }

  if (!(await commandExists("git"))) {
    return {
      ok: false,
      backend: "trope-cua",
      code: "installer_missing",
      plan,
      message:
        "git is required to fetch Trope CUA source. Install git, then rerun `npm run install-adapter`.",
    };
  }

  const installer = platformInstaller(platform);
  const timeoutMs = args.timeout_ms ?? 20 * 60 * 1000;
  const dir = sourceDir();
  const startedAt = Date.now();
  const logs = [];

  // 1) Fetch source (clone fresh, or fast-forward an existing checkout).
  const fetch = existsSync(path.join(dir, ".git"))
    ? await runCommand("git", ["-C", dir, "pull", "--ff-only"], { timeoutMs })
    : await runCommand("git", ["clone", "--depth", "1", REPO, dir], { timeoutMs });
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
  const build = await runCommand(installer.cmd, installer.args, { timeoutMs, cwd: dir });
  logs.push({
    step: "build-install",
    ok: build.ok,
    exitCode: build.exitCode,
    timedOut: build.timedOut,
    stdout: build.stdout.trim().slice(-2000),
    stderr: build.stderr.trim().slice(-2000),
  });

  const detected = await commandExists(detect);
  return {
    ok: build.ok && detected,
    backend: "trope-cua",
    repo: REPO,
    sourceDir: dir,
    duration_ms: Date.now() - startedAt,
    logs,
    message: detected
      ? "Trope CUA installed. Grant the OS permissions it requests (macOS: Accessibility + Screen Recording), then restart Codex."
      : build.ok
        ? `Build finished but \`${detect}\` is not on PATH yet. Restart your terminal/Codex, or set MIMO_COMPUTER_USE_TROPE_CMD to the full path of the installed trope-cua executable.`
        : `Trope CUA build failed — ${platform === "win32" ? ".NET SDK" : "Xcode Command Line Tools"} is likely missing. See logs and ${REPO}.`,
  };
}
