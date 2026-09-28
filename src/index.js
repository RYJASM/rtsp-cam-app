const { app, BrowserWindow, globalShortcut, screen, ipcMain, shell } = require("electron");
const path = require("node:path");
const { exec } = require("node:child_process");

const config = require("./config");
const credentials = require("./credentials");
const stream = require("./stream");
const { ffmpegAvailable } = require("./ffmpeg-path");

if (require("electron-squirrel-startup")) {
  app.quit();
}

let win;
let settingsWin = null;
let windowLevel = "top";
// See-through mode for the main window; pop-outs track their own.
let seeThrough = false;
// Set during app startup so module-scope helpers (createPopout) can reach
// window-management functions defined inside the ready handler.
let applyLevelToWindow = null;
let applySeeThroughToWindow = null;

// Bounds captured when a drag starts, keyed by window id, so every move is
// applied against a fixed reference. Repositioning incrementally accumulates
// rounding error on scaled displays and the window creeps larger as it moves.
const dragOrigins = new Map();

// Pop-out viewers, keyed by BrowserWindow id -> { window, cameraId }
const popouts = new Map();

// Latest status per camera, replayed to a renderer when it (re)loads.
const statusByCamera = new Map();

// Which camera each viewer window is showing. The main window's entry is
// tracked under its own id so both kinds of window share one code path.
const cameraByWindowId = new Map();

function viewerWindows() {
  const list = [];
  if (win && !win.isDestroyed()) list.push(win);
  for (const { window } of popouts.values()) {
    if (window && !window.isDestroyed()) list.push(window);
  }
  return list;
}

// Last known good bounds, kept up to date while the window lives. Reading
// them at quit time is unreliable: closing via the renderer destroys the
// window before before-quit runs, so getBounds() is no longer available.
let lastBounds = null;

function saveWindowState() {
  if (win && !win.isDestroyed()) {
    lastBounds = win.getBounds();
  }
  if (!lastBounds) return;
  config.setWindowState({ ...lastBounds, level: windowLevel, seeThrough });
}

// True once the app is quitting, so windows closing during shutdown are not
// mistaken for the user dismissing them.
let quitting = false;

// Record open pop-outs so they can be restored on the next launch.
function savePopouts() {
  // During shutdown every window closes; persisting then would erase the
  // layout we want to restore.
  if (quitting) return;
  const entries = [];
  for (const entry of popouts.values()) {
    const { window, cameraId } = entry;
    // Explicitly dismissed windows are meant to stay gone.
    if (entry.dismissed) continue;
    if (window && !window.isDestroyed()) {
      // Cache bounds so they survive the window being destroyed.
      entry.lastBounds = window.getBounds();
    }
    if (!entry.lastBounds) continue;
    entries.push({
      cameraId,
      ...entry.lastBounds,
      level: entry.level || "top",
      seeThrough: Boolean(entry.seeThrough),
    });
  }
  config.setPopouts(entries);
}

function broadcastStatus(status) {
  statusByCamera.set(status.cameraId, status);
  // Send only to windows showing this camera, plus settings which reports
  // connection problems while editing.
  for (const target of viewerWindows()) {
    if (cameraByWindowId.get(target.id) === status.cameraId) {
      target.webContents.send("stream-status", status);
    }
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send("stream-status", status);
  }
}

// Tell open windows the camera list changed, so pickers and lists refresh
// even when the change does not restart the stream (a rename, say).
function broadcastCamerasChanged() {
  for (const target of [...viewerWindows(), settingsWin]) {
    if (target && !target.isDestroyed()) {
      target.webContents.send("cameras-changed");
    }
  }
}

// Point a window at a camera, releasing whatever it was watching before.
function attachCamera(browserWindow, cameraId) {
  const watcher = browserWindow.id;
  const previous = cameraByWindowId.get(watcher);
  if (previous && previous !== cameraId) {
    stream.release(previous, watcher);
  }

  const camera = cameraId ? config.getCamera(cameraId) : null;
  if (!camera) {
    cameraByWindowId.set(watcher, null);
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send("stream-status", {
        state: "no-camera", detail: null, cameraId: null,
      });
    }
    return;
  }

  cameraByWindowId.set(watcher, camera.id);

  if (!ffmpegAvailable()) {
    broadcastStatus({
      state: "error",
      detail: "The bundled video engine is missing. Try reinstalling the app.",
      cameraId: camera.id,
    });
    return;
  }

  stream.acquire(camera, watcher);
}

const createWindow = () => {
  const { width: screenW, height: screenH } =
    screen.getPrimaryDisplay().workAreaSize;
  const saved = config.getWindowState();

  win = new BrowserWindow({
    width: saved ? saved.width : DEFAULT_VIEWER_WIDTH,
    height: saved ? saved.height : DEFAULT_VIEWER_HEIGHT,
    x: saved ? saved.x : screenW - DEFAULT_VIEWER_WIDTH - 20,
    y: saved ? saved.y : screenH - DEFAULT_VIEWER_HEIGHT - 20,
    frame: false,
    transparent: true,
    alwaysOnTop: (!saved || saved.level === "top"),
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  // Applied after construction so the restored size is not nudged by the
  // constraint on the way in.
  if (saved) {
    win.setBounds({ x: saved.x, y: saved.y, width: saved.width, height: saved.height });
  }
  win.setAspectRatio(16 / 9);
  lastBounds = win.getBounds();

  if (saved && saved.level) {
    windowLevel = saved.level;
  }
  if (saved && saved.seeThrough) {
    seeThrough = true;
  }
  win.loadFile(path.join(__dirname, "index.html"));

  // Persist as the user moves and resizes, so state does not depend on a
  // clean shutdown path. The X button destroys the window before quit
  // handlers can read its bounds.
  win.on("moved", saveWindowState);
  win.on("resized", saveWindowState);

  win.on("close", () => {
    saveWindowState();
    savePopouts();
  });

  win.on("closed", () => {
    stream.releaseAll(win.id);
    cameraByWindowId.delete(win.id);
    win = null;
  });
};

// Default viewer size, matching the main window's own default.
const DEFAULT_VIEWER_WIDTH = 640;
const DEFAULT_VIEWER_HEIGHT = 360;

// Size a new viewer to match an existing one, falling back to the last saved
// main-window size and finally to the built-in default.
function newViewerSize(sourceWindow) {
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    const b = sourceWindow.getBounds();
    return { width: b.width, height: b.height };
  }
  const saved = config.getWindowState();
  if (saved && saved.width && saved.height) {
    return { width: saved.width, height: saved.height };
  }
  return { width: DEFAULT_VIEWER_WIDTH, height: DEFAULT_VIEWER_HEIGHT };
}

// A pop-out is the same viewer page in its own window, showing one camera.
// `bounds` restores a saved window; `sourceWindow` is the viewer it was opened
// from, whose size a brand-new pop-out adopts.
function createPopout(cameraId, bounds, sourceWindow) {
  const camera = config.getCamera(cameraId);
  if (!camera) return null;

  // Duplicates are allowed: each viewer is an independent window and can be
  // switched to any camera, so two windows on the same camera is a reasonable
  // thing to ask for (watching one feed while comparing another, say).

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  // Cascade new pop-outs so they do not stack exactly on top of each other.
  const offset = popouts.size * 30;
  const size = bounds
    ? { width: bounds.width, height: bounds.height }
    : newViewerSize(sourceWindow);

  const popWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: bounds ? bounds.x : Math.max(0, screenW - size.width - 20 - offset),
    y: bounds ? bounds.y : Math.max(0, screenH - size.height - 20 - offset),
    // Same shape as the main window: pop-outs are full viewers, not a
    // reduced variant.
    frame: false,
    transparent: true,
    alwaysOnTop: bounds && bounds.level ? bounds.level === "top" : true,
    resizable: true,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  popWin.setAspectRatio(16 / 9);
  if (bounds) {
    popWin.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }
  popWin.loadFile(path.join(__dirname, "index.html"));

  popouts.set(popWin.id, {
    window: popWin,
    cameraId,
    level: bounds && bounds.level ? bounds.level : "top",
    seeThrough: Boolean(bounds && bounds.seeThrough),
  });
  // Assign the camera up front so the renderer's getViewContext call cannot
  // race did-finish-load and come back empty.
  cameraByWindowId.set(popWin.id, cameraId);

  popWin.on("close", savePopouts);
  popWin.on("closed", () => {
    stream.releaseAll(popWin.id);
    cameraByWindowId.delete(popWin.id);
    popouts.delete(popWin.id);
    savePopouts();
  });

  popWin.webContents.once("did-finish-load", () => {
    attachCamera(popWin, cameraId);
    // Apply a restored level that needs the window to exist first.
    const entry = popouts.get(popWin.id);
    if (entry && entry.level && entry.level !== "top" && applyLevelToWindow) {
      applyLevelToWindow(popWin, entry.level);
    }
    if (entry && entry.seeThrough && applySeeThroughToWindow) {
      applySeeThroughToWindow(popWin, true);
    }
  });

  // Persist as soon as the window exists, and whenever it is moved or
  // resized, so the layout survives even an unclean exit.
  const persist = () => savePopouts();
  popWin.on("moved", persist);
  popWin.on("resized", persist);
  savePopouts();

  return popWin;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 620,
    title: "Camera Settings",
    // A normal framed window: this is a form, not the always-on-top overlay.
    resizable: true,
    minimizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

app.whenReady().then(() => {
  stream.onStatus(broadcastStatus);

  createWindow();

  // Known before the page loads, so getViewContext always has an answer.
  cameraByWindowId.set(win.id, config.getActiveCameraId());

  win.webContents.once("did-finish-load", () => {
    if (seeThrough && applySeeThroughToWindow) {
      applySeeThroughToWindow(win, true);
    }
    attachCamera(win, config.getActiveCameraId());
    // Restore pop-outs from the previous session.
    for (const saved of config.getPopouts()) {
      createPopout(saved.cameraId, saved);
    }
  });

  // Open settings automatically on a fresh install so the app is usable
  // without the user having to discover the button.
  if (config.listCameras().length === 0) {
    openSettings();
  }

  // Push a window behind everything else. Electron has no cross-platform
  // "send to back", so each platform gets its own approach.
  function sendWindowToBottom(target) {
    if (!target || target.isDestroyed()) return;

    if (process.platform === "darwin") {
      // macOS has a real desktop-level window layer: sitting there keeps the
      // window behind ordinary applications without further intervention.
      target.setAlwaysOnTop(false);
      try {
        target.setAlwaysOnTop(true, "desktop");
      } catch {
        // Older Electron without the level argument: nothing more to do.
      }
      return;
    }

    if (process.platform === "win32") {
      // Use the native Windows API to place the window at the bottom of the
      // z-order, which Electron does not expose.
      const handle = target.getNativeWindowHandle();
      // Spawn a quick PowerShell command to call SetWindowPos with HWND_BOTTOM
      const hwnd = handle.readInt32LE(0);
      exec(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport(\\\"user32.dll\\\")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int h2,uint f);}'; [W]::SetWindowPos([IntPtr]${hwnd},[IntPtr]1,0,0,0,0,0x0013)"`
      );
      return;
    }

    // Linux and anything else: the best available approximation.
    target.setAlwaysOnTop(false);
    target.blur();
  }

  function sendToBottom() {
    sendWindowToBottom(win);
  }

  ipcMain.on("set-window-level", (event, level) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return;

    if (target === win) {
      windowLevel = level;
      applyLevelTo(win, windowLevel);
      // Record immediately rather than hoping for a clean exit.
      saveWindowState();
      return;
    }

    // Pop-outs carry their own level.
    const entry = popouts.get(target.id);
    if (!entry) return;
    entry.level = level;
    applyLevelTo(target, level);
    savePopouts();
  });

  // Apply a z-order level to any viewer window.
  function applyLevelTo(target, level) {
    if (!target || target.isDestroyed()) return;
    if (level === "top") {
      target.setAlwaysOnTop(true);
    } else if (level === "bottom") {
      target.setAlwaysOnTop(false);
      sendWindowToBottom(target);
    } else {
      target.setAlwaysOnTop(false);
    }
  }

  // Apply bottom mode once window is shown
  win.once("show", () => {
    if (windowLevel === "bottom") {
      sendToBottom();
    }
  });

  // Keep window at bottom when in "bottom" mode
  win.on("focus", () => {
    if (windowLevel === "bottom") {
      sendToBottom();
    }
  });

  // Tracks the main window while it is being dragged, so other logic can tell
  // a user-driven move from a programmatic one.
  let draggingMain = false;

  applyLevelToWindow = applyLevelTo;
  applySeeThroughToWindow = applySeeThrough;

  ipcMain.handle("get-window-level", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target === win) return windowLevel;
    const entry = popouts.get(target.id);
    return entry && entry.level ? entry.level : "top";
  });

  // Ask Windows to round the window itself. The acrylic layer is drawn by the
  // compositor against the window's own shape, so the page's border-radius
  // cannot clip it - the corners come out square unless the OS rounds them.
  function roundWindowCorners(target) {
    if (process.platform !== "win32") return;
    if (!target || target.isDestroyed()) return;
    try {
      const buf = target.getNativeWindowHandle();
      const hwnd = (buf.length === 8
        ? buf.readBigUInt64LE(0)
        : BigInt(buf.readUInt32LE(0))).toString();
      // DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2
      exec(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;` +
        `using System.Runtime.InteropServices;public class D{[DllImport(\\\"dwmapi.dll\\\")]` +
        `public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);}';` +
        `$v=2; [D]::DwmSetWindowAttribute([IntPtr]${hwnd},33,[ref]$v,4)"`
      );
    } catch {
      // Pre-Windows 11, or DWM unavailable: corners stay square.
    }
  }

  // Blur whatever sits behind the window while it is see-through. This is the
  // OS compositor's own acrylic effect - CSS backdrop-filter only reaches the
  // page's own content, never the desktop behind it.
  // How solid the window is while see-through. Lower is more transparent.
  const SEE_THROUGH_OPACITY = 0.85;

  function applySeeThrough(target, on) {
    if (!target || target.isDestroyed()) return;

    // Fade the whole window at the OS level. This shows the desktop through
    // clearly, where the compositor's acrylic material mostly applies a grey
    // tint - it washes out over dark backgrounds, which a camera view usually
    // is.
    try {
      target.setOpacity(on ? SEE_THROUGH_OPACITY : 1);
    } catch {
      // Not supported everywhere; the CSS fade still applies.
    }

    if (on) roundWindowCorners(target);
  }

  ipcMain.on("set-see-through", (event, on) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target.isDestroyed()) return;
    applySeeThrough(target, on);
    if (target === win) {
      seeThrough = Boolean(on);
      saveWindowState();
      return;
    }
    const entry = popouts.get(target.id);
    if (!entry) return;
    entry.seeThrough = Boolean(on);
    savePopouts();
  });

  ipcMain.handle("get-see-through", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || target === win) return seeThrough;
    const entry = popouts.get(target.id);
    return Boolean(entry && entry.seeThrough);
  });

  ipcMain.on("set-always-on-top", (event, flag) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (target && !target.isDestroyed()) target.setAlwaysOnTop(flag);
  });

  // --- Window identity -----------------------------------------------------

  // Each viewer asks which camera it is showing, and whether it is a pop-out
  // (pop-outs hide the picker and show a close-only control set).
  ipcMain.handle("get-view-context", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow) return { cameraId: null, isPopout: false, wsPort: stream.WS_PORT };
    const isPopout = popouts.has(browserWindow.id);
    return {
      cameraId: cameraByWindowId.get(browserWindow.id) || null,
      isPopout,
      wsPort: stream.WS_PORT,
    };
  });

  // Manual window dragging. The renderer reports pointer deltas because a
  // CSS drag region would sit over the whole video and swallow clicks meant
  // for the controls and the camera menu.
  ipcMain.on("drag-start", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isDestroyed()) return;
    dragOrigins.set(browserWindow.id, browserWindow.getBounds());
    // A window being dragged should be visible, whatever its usual level.
    browserWindow.setAlwaysOnTop(true);
    if (browserWindow === win) draggingMain = true;
  });

  ipcMain.on("drag-window", (event, delta) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isDestroyed()) return;
    const origin = dragOrigins.get(browserWindow.id);
    if (!origin) return;

    // Absolute placement from the origin, restating the original size so the
    // window cannot drift over the course of a drag.
    const target = snapToPixelGrid(origin.x + delta.dx, origin.y + delta.dy);
    browserWindow.setBounds({
      x: target.x,
      y: target.y,
      width: origin.width,
      height: origin.height,
    });
  });

  // On a fractionally scaled display a position that does not land on a whole
  // device pixel makes Windows round the window's size up by one, so the frame
  // visibly pulses between two sizes as it is dragged. Snapping the position to
  // the grid where DIPs map to whole pixels keeps the size constant.
  function snapToPixelGrid(x, y) {
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    const scale = display ? display.scaleFactor : 1;
    if (!scale || Number.isInteger(scale)) {
      return { x: Math.round(x), y: Math.round(y) };
    }
    // Smallest DIP step that is a whole number of device pixels: for 1.5 that
    // is 2 DIPs (3px), for 1.25 it is 4 DIPs (5px).
    let step = 1;
    while (step <= 8 && !Number.isInteger(step * scale)) step++;
    const snap = (value) => Math.round(value / step) * step;
    return { x: snap(x), y: snap(y) };
  }

  ipcMain.on("drag-end", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isDestroyed()) return;
    dragOrigins.delete(browserWindow.id);

    // Restore the window's configured z-order now the drag has finished.
    if (browserWindow === win) {
      draggingMain = false;
      applyLevelTo(win, windowLevel);
    } else {
      const entry = popouts.get(browserWindow.id);
      if (entry) applyLevelTo(browserWindow, entry.level || "top");
    }

    // The drag moved the window; record its new position.
    saveWindowState();
    savePopouts();
  });

  // Quit: save the whole layout, then exit. Every open window is remembered
  // and comes back on the next launch.
  ipcMain.handle("close-window", () => {
    saveWindowState();
    savePopouts();
    app.quit();
  });

  ipcMain.handle("minimize-window", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isDestroyed()) return { ok: false };

    // An always-on-top window will not stay minimized on Windows, so drop the
    // flag first and put it back when the window is restored.
    const wasOnTop = browserWindow.isAlwaysOnTop();
    if (wasOnTop) {
      browserWindow.setAlwaysOnTop(false);
      browserWindow.once("restore", () => {
        if (browserWindow.isDestroyed()) return;
        const level = browserWindow === win
          ? windowLevel
          : (popouts.get(browserWindow.id) || {}).level || "top";
        applyLevelTo(browserWindow, level);
      });
    }
    browserWindow.minimize();
    return { ok: true };
  });

  // Dismiss a single viewer. The window is removed from the saved layout, so
  // it does not reappear next launch - that is what makes this different from
  // quitting.
  ipcMain.handle("dismiss-window", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow || browserWindow.isDestroyed()) return { ok: false };

    if (popouts.has(browserWindow.id)) {
      const entry = popouts.get(browserWindow.id);
      // Forget its bounds so the closed handler cannot persist it again.
      entry.dismissed = true;
      browserWindow.close();
      return { ok: true, quit: false };
    }

    // The main window owns the app's lifetime, so dismissing it exits. Its
    // own position is still worth keeping, but any pop-outs the user dismissed
    // along the way stay dismissed.
    saveWindowState();
    savePopouts();
    app.quit();
    return { ok: true, quit: true };
  });

  // --- Camera management ---------------------------------------------------

  ipcMain.handle("open-settings", () => openSettings());

  ipcMain.handle("get-stream-status", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const cameraId = browserWindow ? cameraByWindowId.get(browserWindow.id) : null;
    if (!cameraId) return { state: "no-camera", detail: null, cameraId: null };
    return statusByCamera.get(cameraId) || stream.statusOf(cameraId);
  });

  // Never return passwords to the renderer; expose only whether one is set.
  ipcMain.handle("list-cameras", () => {
    const activeId = config.getActiveCameraId();
    const openCameraIds = Array.from(popouts.values()).map((p) => p.cameraId);
    return {
      activeId,
      openCameraIds,
      keychainAvailable: credentials.isAvailable(),
      cameras: config.listCameras().map((camera) => ({
        ...camera,
        hasPassword: credentials.hasPassword(camera.id),
      })),
    };
  });

  ipcMain.handle("save-camera", (_event, input) => {
    if (!input || !input.host) {
      return { ok: false, error: "A camera address is required." };
    }
    const record = config.upsertCamera({
      id: input.id,
      name: input.name,
      host: String(input.host).trim(),
      port: Number(input.port) || 554,
      pathname: String(input.pathname || "/stream1").trim(),
      username: String(input.username || "").trim(),
      transport: input.transport,
    });

    // A password of undefined means "leave unchanged"; empty string clears it.
    if (typeof input.password === "string") {
      credentials.setPassword(record.id, input.password);
    }

    broadcastCamerasChanged();
    // Reconnect any window already watching this camera with the new details.
    stream.restart(record);
    return { ok: true, id: record.id };
  });

  ipcMain.handle("delete-camera", (_event, id) => {
    // Close any pop-out showing the camera being removed.
    for (const entry of Array.from(popouts.values())) {
      if (entry.cameraId === id && entry.window && !entry.window.isDestroyed()) {
        entry.window.close();
      }
    }

    const wasActive = config.getActiveCameraId() === id;
    config.removeCamera(id);
    credentials.deletePassword(id);
    broadcastCamerasChanged();
    if (wasActive && win) attachCamera(win, config.getActiveCameraId());
    return { ok: true };
  });

  ipcMain.handle("select-camera", (event, id) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    // Switching from a viewer changes that window; from settings it changes
    // the main window.
    const target = browserWindow && popouts.has(browserWindow.id) ? browserWindow : win;
    if (target === win) {
      config.setActiveCameraId(id);
    } else {
      popouts.get(target.id).cameraId = id;
      savePopouts();
    }
    attachCamera(target, id);
    broadcastCamerasChanged();
    return { ok: true };
  });

  ipcMain.handle("popout-camera", (event, id) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const cameraId = id || (browserWindow ? cameraByWindowId.get(browserWindow.id) : null);
    if (!cameraId) return { ok: false };
    // Inherit the size of the window it was opened from, so a new viewer
    // matches what the user is already looking at.
    createPopout(cameraId, null, browserWindow);
    savePopouts();
    broadcastCamerasChanged();
    return { ok: true };
  });

  ipcMain.handle("retry-stream", (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const cameraId = browserWindow ? cameraByWindowId.get(browserWindow.id) : null;
    const camera = cameraId ? config.getCamera(cameraId) : null;
    if (camera) stream.restart(camera);
    return { ok: true };
  });

  ipcMain.handle("open-config-folder", () => {
    shell.showItemInFolder(config.configPath);
  });

  // Escape mirrors the quit button: save the layout, then exit.
  globalShortcut.register("Escape", () => {
    saveWindowState();
    savePopouts();
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

// Capture the layout before any window starts closing.
app.on("before-quit", () => {
  saveWindowState();
  savePopouts();
  quitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stream.shutdown();
});
