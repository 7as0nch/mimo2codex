import { chooseAdapter, waitMs } from "./adapters.mjs";
import { adapterInstallPlan, installAdapter } from "./installers.mjs";
import { notify } from "./notify.mjs";
import { isStopped } from "./overlay.mjs";
import { checkUserTakeover, recordAiCursor, rebaseline } from "./watch.mjs";

// Tools that actually drive the mouse/keyboard — blocked while the user has
// pressed Stop on the overlay. computer_state / computer_wait stay allowed so
// the model can still observe and the user can read the panel.
const ACTION_TOOLS = new Set(["computer_click", "computer_type", "computer_key", "computer_scroll"]);

const coordinateProps = {
  x: { type: "number", description: "Target x coordinate in screen-mouse pixels (see computer_state.size / scale)." },
  y: { type: "number", description: "Target y coordinate in screen-mouse pixels." },
};

export const tools = [
  {
    name: "computer_state",
    description:
      "Capture the screen. Returns the screen `size`, a `scale`, a saved screenshot path, a downscaled screenshot image, and OCR'd on-screen text `targets` with click coordinates. If you can see images, LOOK at the screenshot to choose where to click. If you can't (text-only model), click a `target` by passing its text to computer_click. Always call this before clicking.",
    inputSchema: {
      type: "object",
      properties: {
        ocr: { type: "boolean", description: "Return clickable OCR text `targets` (default true). Set false to skip OCR. Needs tesseract installed." },
        include_image: { type: "boolean", description: "Embed the downscaled screenshot image (default true). Vision models see it; for non-vision models it's stripped — pass false to save tokens." },
        image_width: { type: "number", description: "Max width of the embedded screenshot in px (default 1024)." },
        image_quality: { type: "number", description: "JPEG quality of the embedded screenshot, 1-100 (default 50)." },
        lang: { type: "string", description: "OCR language hint, e.g. 'Chinese' or 'en'." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_click",
    description:
      "Move the mouse to a point and click. Give x/y coordinates (preferred), or a `target` text that will be matched against on-screen OCR. The cursor glides visibly to the point before clicking.",
    inputSchema: {
      type: "object",
      properties: {
        ...coordinateProps,
        target: { type: "string", description: "Visible text to click, matched via OCR when x/y are omitted." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)." },
        double: { type: "boolean", description: "Double-click instead of single-click." },
        speed: { type: "number", description: "Cursor travel speed in pixels/second (default 2200)." },
        lang: { type: "string", description: "OCR language hint when using `target`." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_type",
    description: "Type literal text into the focused field.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Literal text to type." },
        clear: { type: "boolean", description: "Select-all + delete before typing (clears the field)." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      required: ["text"],
      additionalProperties: true,
    },
  },
  {
    name: "computer_key",
    description: "Press a key or shortcut, e.g. Enter, Escape, Ctrl+C, Cmd+L, Alt+Tab, PageDown.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Single key or '+'-joined combo." },
        combo: { type: "string", description: "Alias for key." },
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_scroll",
    description: "Scroll the view (optionally after moving to x/y).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Number of scroll steps (default 3)." },
        ...coordinateProps,
        timeout_ms: { type: "number", description: "Adapter timeout in milliseconds." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "computer_wait",
    description: "Wait for the UI to settle. Handled internally; does not touch the OS.",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number", description: "Milliseconds to wait, capped at 60000." } },
      additionalProperties: false,
    },
  },
  {
    name: "computer_install_adapter",
    description:
      "Install the plugin's pure-Node dependencies (nut.js; optionally the Electron glowing-cursor overlay). Use only after telling the user a download will run.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", description: "Return the install plan without running commands." },
        confirm_install: { type: "boolean", description: "Must be true before downloading/installing." },
        with_electron: { type: "boolean", description: "Also install Electron for the on-desktop glowing cursor." },
        timeout_ms: { type: "number", description: "Installer timeout in milliseconds." },
      },
      additionalProperties: false,
    },
  },
];

// Mirror an executed action to the overlay + admin panel. Best-effort.
function emit(name, args, result) {
  if (!result || result.ok === false) return;
  if (name === "computer_state") {
    notify({ type: "state", frameName: result.screenshot?.frameName, size: result.size, scale: result.scale });
  } else if (name === "computer_click") {
    notify({ type: "click", x: result.x, y: result.y, button: result.button, double: result.double });
  } else if (name === "computer_type") {
    notify({ type: "type", chars: result.typed });
  } else if (name === "computer_key") {
    notify({ type: "key", key: result.key });
  } else if (name === "computer_scroll") {
    notify({ type: "scroll", direction: result.direction, x: args.x, y: args.y });
  }
}

export async function callTool(name, args = {}) {
  if (name === "computer_wait") return await waitMs(args.ms);
  if (name === "computer_install_adapter") {
    if (args.dry_run === true) return adapterInstallPlan();
    return await installAdapter(args);
  }
  if (ACTION_TOOLS.has(name) && isStopped()) {
    return {
      ok: false,
      code: "stopped_by_user",
      message: "The user pressed Stop on the overlay. Do not keep automating — wait until they ask you to resume (or press Resume).",
    };
  }
  // Human-takeover watch: if the user moved the mouse since the AI last left it,
  // pause this action and let the user correct. Re-syncs on the next
  // computer_state. Skipped while stopped/already handled above.
  if (ACTION_TOOLS.has(name)) {
    const takeover = await checkUserTakeover();
    if (takeover) {
      notify({ type: "intervened", x: takeover.to.x, y: takeover.to.y });
      return {
        ok: false,
        code: "user_intervened",
        takeover,
        message:
          "⚠️ The user moved the mouse — they may be taking over or correcting you. I've paused. " +
          "Stop automating, ask the user what they want changed, and call computer_state to re-sync before continuing.",
      };
    }
  }

  const adapter = chooseAdapter();
  const handlers = {
    computer_state: "computerState",
    computer_click: "computerClick",
    computer_type: "computerType",
    computer_key: "computerKey",
    computer_scroll: "computerScroll",
  };
  const handler = handlers[name];
  if (!handler || typeof adapter.module[handler] !== "function") {
    return { ok: false, code: "unknown_tool", message: `Unknown mimo-computer-use tool: ${name}` };
  }
  const result = await adapter.module[handler](args);
  emit(name, args, result);

  // Maintain the takeover baseline: record where the AI left the cursor after a
  // move, and re-baseline (clearing any takeover) whenever the AI re-observes.
  if (result?.ok !== false) {
    if (name === "computer_click" && Number.isFinite(result?.x)) recordAiCursor(result.x, result.y);
    else if (name === "computer_scroll" && Number.isFinite(args.x) && Number.isFinite(args.y)) recordAiCursor(args.x, args.y);
    else if (name === "computer_state") await rebaseline();
  }
  return result;
}

export function textResult(payload) {
  const image = payload?.screenshot?.image;
  // Strip the (large) base64 out of the JSON text block — it goes in its own
  // image block instead, so it isn't duplicated as a giant string.
  let textPayload = payload;
  if (image) {
    textPayload = { ...payload, screenshot: { ...payload.screenshot, image: undefined } };
  }
  const content = [{ type: "text", text: JSON.stringify(textPayload, null, 2) }];
  // A-perception: hand vision-capable clients the actual pixels as an MCP image
  // block. The text block (path + size + scale + targets) is always present so
  // text-only models and tool-result history stay functional.
  if (image) {
    content.unshift({ type: "image", data: image, mimeType: payload?.screenshot?.imageMime ?? "image/png" });
  }
  return { content, isError: payload?.ok === false };
}
