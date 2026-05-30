import { platform as nodePlatform } from "node:process";
import { commandExists, runCommand } from "./shell.mjs";

export function adapterInstallPlan(env = process.env, platform = nodePlatform) {
  const forced = (env.MIMO_COMPUTER_USE_BACKEND || "auto").toLowerCase();
  const backend =
    forced === "peekaboo" || (forced === "auto" && platform === "darwin")
      ? "peekaboo"
      : forced === "windows-mcp" || (forced === "auto" && platform === "win32")
        ? "windows-mcp"
        : forced === "trope"
          ? "trope-cua"
          : "unsupported";

  if (backend === "peekaboo") {
    return {
      ok: true,
      backend,
      platform,
      autoInstall: true,
      command: ["brew", "install", "steipete/tap/peekaboo"],
      detects: ["peekaboo"],
      permissions: ["Screen Recording", "Accessibility"],
      message:
        "Peekaboo will be installed with Homebrew. After install, grant macOS Screen Recording and Accessibility permissions.",
    };
  }

  if (backend === "windows-mcp") {
    return {
      ok: true,
      backend,
      platform,
      autoInstall: true,
      command: ["uv", "tool", "install", "windows-mcp"],
      fallbackCommand: ["uvx", "windows-mcp", "--help"],
      detects: ["windows-mcp", "uvx"],
      permissions: [],
      message:
        "Windows-MCP will be installed from PyPI with uv. If uv is unavailable, install uv first or use uvx windows-mcp serve.",
    };
  }

  if (backend === "trope-cua") {
    return {
      ok: false,
      backend,
      platform,
      autoInstall: false,
      code: "manual_install_required",
      message:
        "Trope CUA is experimental in mimo-computer-use and does not have an automatic installer yet. Install it externally, then set MIMO_COMPUTER_USE_BACKEND=trope.",
    };
  }

  return {
    ok: false,
    backend,
    platform,
    autoInstall: false,
    code: "unsupported_platform",
    message: "Automatic adapter installation currently supports macOS and Windows only.",
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
        "Adapter installation downloads third-party software. Explain the plan to the user first, then call again with confirm_install=true.",
    };
  }

  const timeoutMs = args.timeout_ms ?? 10 * 60 * 1000;

  if (plan.backend === "peekaboo") {
    if (await commandExists("peekaboo")) {
      return {
        ok: true,
        backend: plan.backend,
        alreadyInstalled: true,
        message: "Peekaboo is already installed.",
      };
    }
    if (!(await commandExists("brew"))) {
      return {
        ok: false,
        backend: plan.backend,
        code: "installer_missing",
        plan,
        message:
          "Homebrew is not available. Install Homebrew first, then rerun this installer or run `brew install steipete/tap/peekaboo`.",
      };
    }
    const startedAt = Date.now();
    const result = await runCommand("brew", ["install", "steipete/tap/peekaboo"], { timeoutMs });
    return {
      ok: result.ok && (await commandExists("peekaboo")),
      backend: plan.backend,
      command: plan.command,
      duration_ms: Date.now() - startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      message: result.ok
        ? "Peekaboo install command completed. Grant Screen Recording and Accessibility permissions before first desktop operation."
        : "Peekaboo install command failed. Check stderr and install manually if needed.",
    };
  }

  if (plan.backend === "windows-mcp") {
    if (await commandExists("windows-mcp")) {
      return {
        ok: true,
        backend: plan.backend,
        alreadyInstalled: true,
        command: ["windows-mcp", "serve"],
        message: "Windows-MCP executable is already installed.",
      };
    }
    if (await commandExists("uv")) {
      const startedAt = Date.now();
      const result = await runCommand("uv", ["tool", "install", "windows-mcp"], { timeoutMs });
      const detected = await commandExists("windows-mcp");
      return {
        ok: result.ok && detected,
        backend: plan.backend,
        command: plan.command,
        duration_ms: Date.now() - startedAt,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        message: detected
          ? "Windows-MCP installed. Restart Codex so PATH changes are visible if needed."
          : "uv finished but windows-mcp is not on PATH yet. Restart the terminal/Codex or use MIMO_COMPUTER_USE_WINDOWS_MCP_CMD with the full executable path.",
      };
    }
    if (await commandExists("uvx")) {
      const startedAt = Date.now();
      const result = await runCommand("uvx", ["windows-mcp", "--help"], { timeoutMs });
      return {
        ok: result.ok,
        backend: plan.backend,
        command: plan.fallbackCommand,
        duration_ms: Date.now() - startedAt,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        message: result.ok
          ? "uvx resolved Windows-MCP. The adapter will run `uvx windows-mcp serve` when no windows-mcp executable is on PATH."
          : "uvx could not resolve Windows-MCP. Install uv or windows-mcp manually.",
      };
    }
    return {
      ok: false,
      backend: plan.backend,
      code: "installer_missing",
      plan,
      message:
        "Neither uv nor uvx is available. Install uv from https://docs.astral.sh/uv/, then rerun `npm run install-adapter`.",
    };
  }

  return plan;
}
