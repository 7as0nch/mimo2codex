import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// plugins/mimo-computer-use/server/lib → up 3 = plugins/mimo-computer-use
export function pluginRoot() {
  return path.resolve(here, "..", "..");
}

// Repo root (…/mimo2codex), used to locate mimoskill/ helpers.
export function repoRoot() {
  return path.resolve(pluginRoot(), "..", "..");
}

// node_modules dir the plugin installs its own deps (nut.js, electron) into.
export function pluginNodeModules() {
  return path.join(pluginRoot(), "node_modules");
}

// Working dir for computer-use artifacts (screenshots). Follows the proxy's
// data dir when it passes MIMO2CODEX_COMPUTER_USE_DIR; otherwise defaults under
// ~/.mimo2codex so the admin panel (same default) can read the frames back.
export function computerUseDir() {
  return (
    process.env.MIMO2CODEX_COMPUTER_USE_DIR ||
    path.join(os.homedir(), ".mimo2codex", "computer-use")
  );
}

export function framesDir() {
  const dir = path.join(computerUseDir(), "frames");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The Electron overlay entry script shipped with the plugin.
export function overlayMainPath() {
  return path.join(pluginRoot(), "overlay", "main.cjs");
}
