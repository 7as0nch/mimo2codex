import path from "node:path";
import { runCommand, commandExists } from "./shell.mjs";
import { repoRoot } from "./paths.mjs";

// C-perception path: text-only models (DeepSeek, mimo-v2.5-pro …) can't see the
// screenshot, so we OCR it into a list of on-screen text targets WITH
// coordinates. The model then asks to click a target by its text and we map it
// to a screen point. Reuses mimoskill/scripts/ocr.py (stdlib + tesseract, no
// pip) in its --boxes mode.

function ocrScript() {
  return path.join(repoRoot(), "mimoskill", "scripts", "ocr.py");
}

async function pythonCmd() {
  for (const c of process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]) {
    if (await commandExists(c)) return c;
  }
  return null;
}

// Returns { ok, targets: [{text, x, y, w, h, cx, cy}], engine, message }.
// `cx/cy` are the box center — the point we click for that target.
export async function ocrBoxes(imagePath, opts = {}) {
  const py = await pythonCmd();
  if (!py) {
    return { ok: false, code: "python_missing", targets: [], message: "Python 3 not found on PATH; cannot OCR for text-only models." };
  }
  const args = [ocrScript(), "--boxes", "--json"];
  if (opts.lang) args.push("--lang", String(opts.lang));
  args.push(imagePath);

  const res = await runCommand(py, args, { timeoutMs: opts.timeoutMs ?? 30_000 });
  if (!res.ok) {
    return {
      ok: false,
      code: "ocr_failed",
      targets: [],
      message: `OCR failed: ${(res.stderr || res.error || "").trim().slice(-400)}`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const raw = Array.isArray(parsed) ? parsed : parsed.boxes ?? parsed.targets ?? [];
    const targets = raw
      .filter((b) => b && typeof b.text === "string" && b.text.trim())
      .map((b) => ({
        text: b.text.trim(),
        x: Number(b.x) || 0,
        y: Number(b.y) || 0,
        w: Number(b.w) || 0,
        h: Number(b.h) || 0,
        cx: Math.round((Number(b.x) || 0) + (Number(b.w) || 0) / 2),
        cy: Math.round((Number(b.y) || 0) + (Number(b.h) || 0) / 2),
      }));
    return { ok: true, engine: parsed.engine ?? "tesseract", targets };
  } catch (e) {
    return { ok: false, code: "ocr_parse_failed", targets: [], message: `Could not parse OCR output: ${e?.message ?? e}` };
  }
}

// Best-match a text query against OCR targets so computer_click can accept a
// `target` string from a text-only model. Exact (case-insensitive) wins, then
// substring, then the shortest target containing all query words.
export function matchTarget(targets, query) {
  if (!query || !Array.isArray(targets)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const exact = targets.find((t) => t.text.toLowerCase() === q);
  if (exact) return exact;
  const sub = targets
    .filter((t) => t.text.toLowerCase().includes(q))
    .sort((a, b) => a.text.length - b.text.length)[0];
  if (sub) return sub;
  const words = q.split(/\s+/).filter(Boolean);
  const all = targets
    .filter((t) => {
      const tl = t.text.toLowerCase();
      return words.every((w) => tl.includes(w));
    })
    .sort((a, b) => a.text.length - b.text.length)[0];
  return all ?? null;
}
