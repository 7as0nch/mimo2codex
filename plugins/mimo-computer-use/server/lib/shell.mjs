import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

export async function commandExists(command) {
  if (!command) return false;
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const dir of paths) {
    for (const ext of extensions) {
      const full = `${dir}/${command}${ext}`;
      try {
        await access(full, constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

export function runCommand(command, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr, error: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr, timedOut });
    });
  });
}
