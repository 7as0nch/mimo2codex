// Electron overlay process for mimo-computer-use.
//
// Spawned on demand by server/lib/overlay.mjs (only when the user installed
// Electron). It draws a glowing cursor on the REAL desktop and shows a
// Stop/Resume pill. Communication:
//   • stdin  (MCP server → overlay): one JSON action event per line
//             {type:'click'|'move'|'state'|'scroll'|'type'|'key'|'hide', x, y, …}
//   • stdout (overlay → MCP server): {"event":"stop"} / {"event":"resume"}
//             from the pill button or the global hotkey.
//
// The glow window is transparent, always-on-top and click-through, so it never
// intercepts the clicks nut.js is performing underneath it.

const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require("electron");
const path = require("path");

let glow = null;
let pill = null;
let ready = false;
const queue = [];

function sendGlow(evt) {
  if (!glow || glow.isDestroyed()) return;
  if (!ready) {
    queue.push(evt);
    return;
  }
  glow.webContents.executeJavaScript(`window.__cursor && window.__cursor(${JSON.stringify(evt)})`).catch(() => {});
}

function emitControl(event) {
  try {
    process.stdout.write(JSON.stringify({ event }) + "\n");
  } catch {
    /* parent gone */
  }
}

function createWindows() {
  if (app.dock) app.dock.hide();
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  glow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true },
  });
  glow.setIgnoreMouseEvents(true, { forward: true });
  glow.setAlwaysOnTop(true, "screen-saver");
  glow.loadFile(path.join(__dirname, "glow.html"));
  glow.webContents.on("did-finish-load", () => {
    ready = true;
    while (queue.length) sendGlow(queue.shift());
  });

  pill = new BrowserWindow({
    width: 150,
    height: 48,
    x: x + width - 170,
    y: y + 22,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  pill.setAlwaysOnTop(true, "screen-saver");
  pill.loadFile(path.join(__dirname, "stop.html"));

  globalShortcut.register("CommandOrControl+Alt+Escape", () => {
    emitControl("stop");
    sendGlow({ type: "hide" });
    if (pill && !pill.isDestroyed()) pill.webContents.executeJavaScript("window.__setStopped && window.__setStopped(true)").catch(() => {});
  });
}

// Pill button → control events back to the MCP server.
ipcMain.on("overlay-control", (_e, msg) => {
  if (msg === "stop" || msg === "resume") {
    emitControl(msg);
    if (msg === "stop") sendGlow({ type: "hide" });
  }
});

app.whenReady().then(createWindows);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());

// stdin: action events from the MCP server.
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      sendGlow(JSON.parse(line));
    } catch {
      /* ignore malformed line */
    }
  }
});
process.stdin.on("close", () => app.quit());
process.stdin.resume();
