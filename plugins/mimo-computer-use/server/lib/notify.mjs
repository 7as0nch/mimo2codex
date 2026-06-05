import { sendOverlay } from "./overlay.mjs";
import { postEvent } from "./events.mjs";

// Single producer → two consumers: every executed action is mirrored to (1) the
// on-desktop Electron overlay via stdin and (2) the proxy's admin panel via
// localhost HTTP. Both are best-effort and never throw into the caller.
export function notify(event) {
  try {
    sendOverlay(event);
  } catch {
    /* overlay is optional */
  }
  // Fire-and-forget; postEvent swallows its own errors.
  void postEvent(event);
}
