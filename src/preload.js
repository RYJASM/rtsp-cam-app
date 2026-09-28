const { contextBridge, ipcRenderer } = require("electron");

// Explicit allowlist of operations the renderer may perform. Nothing here
// exposes ipcRenderer itself, so pages cannot reach arbitrary channels.
contextBridge.exposeInMainWorld("electronAPI", {
  // Window placement
  setAlwaysOnTop: (flag) => ipcRenderer.send("set-always-on-top", flag),
  setWindowLevel: (level) => ipcRenderer.send("set-window-level", level),
  getWindowLevel: () => ipcRenderer.invoke("get-window-level"),
  setSeeThrough: (on) => ipcRenderer.send("set-see-through", on),
  getSeeThrough: () => ipcRenderer.invoke("get-see-through"),

  // Cameras
  listCameras: () => ipcRenderer.invoke("list-cameras"),
  saveCamera: (camera) => ipcRenderer.invoke("save-camera", camera),
  deleteCamera: (id) => ipcRenderer.invoke("delete-camera", id),
  selectCamera: (id) => ipcRenderer.invoke("select-camera", id),

  popoutCamera: (id) => ipcRenderer.invoke("popout-camera", id),

  // Window identity
  getViewContext: () => ipcRenderer.invoke("get-view-context"),
  closeWindow: () => ipcRenderer.invoke("close-window"),
  dismissWindow: () => ipcRenderer.invoke("dismiss-window"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragWindow: (dx, dy) => ipcRenderer.send("drag-window", { dx, dy }),
  dragEnd: () => ipcRenderer.send("drag-end"),

  // Stream
  getStreamStatus: () => ipcRenderer.invoke("get-stream-status"),
  retryStream: () => ipcRenderer.invoke("retry-stream"),
  onStreamStatus: (callback) => {
    // Wrap so the renderer receives only the payload, never the IPC event
    // object (which exposes the sender).
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("stream-status", listener);
    return () => ipcRenderer.removeListener("stream-status", listener);
  },

  onCamerasChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("cameras-changed", listener);
    return () => ipcRenderer.removeListener("cameras-changed", listener);
  },

  // Settings window
  openSettings: () => ipcRenderer.invoke("open-settings"),
  openConfigFolder: () => ipcRenderer.invoke("open-config-folder"),
});
