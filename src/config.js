// Persistent user configuration: the camera list plus app-wide settings.
//
// Camera passwords are deliberately NOT stored here. The config file sits in
// plain view under userData, so secrets go to the OS keychain via
// credentials.js and this file keeps only a reference to them.

const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const configPath = path.join(app.getPath("userData"), "config.json");

const DEFAULTS = {
  version: 1,
  cameras: [],
  activeCameraId: null,
  window: null,
  // Pop-out windows to restore on launch: [{ cameraId, x, y, width, height }]
  popouts: [],
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(config) {
  const tmp = configPath + ".tmp";
  // Write-then-rename so a crash mid-write cannot truncate a good config.
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, configPath);
}

// --- Camera records --------------------------------------------------------
//
// A camera is stored as its connection parts rather than a single URL string,
// so the password can be held separately and the URL rebuilt on demand.

function newCameraId() {
  return crypto.randomUUID();
}

function listCameras() {
  return readConfig().cameras;
}

function getCamera(id) {
  return readConfig().cameras.find((c) => c.id === id) || null;
}

function upsertCamera(camera) {
  const config = readConfig();
  const record = {
    id: camera.id || newCameraId(),
    name: camera.name || "Camera",
    host: camera.host,
    port: camera.port || 554,
    pathname: camera.pathname || "/stream1",
    username: camera.username || "",
    transport: camera.transport === "udp" ? "udp" : "tcp",
  };

  const index = config.cameras.findIndex((c) => c.id === record.id);
  if (index === -1) {
    config.cameras.push(record);
  } else {
    config.cameras[index] = record;
  }

  // First camera added becomes the active one.
  if (!config.activeCameraId) {
    config.activeCameraId = record.id;
  }

  writeConfig(config);
  return record;
}

function removeCamera(id) {
  const config = readConfig();
  config.cameras = config.cameras.filter((c) => c.id !== id);
  if (config.activeCameraId === id) {
    config.activeCameraId = config.cameras.length ? config.cameras[0].id : null;
  }
  writeConfig(config);
}

function getActiveCameraId() {
  return readConfig().activeCameraId;
}

function setActiveCameraId(id) {
  const config = readConfig();
  config.activeCameraId = id;
  writeConfig(config);
}

// --- Window state ----------------------------------------------------------

function getWindowState() {
  return readConfig().window;
}

function setWindowState(state) {
  const config = readConfig();
  config.window = state;
  writeConfig(config);
}

// --- Pop-out windows -------------------------------------------------------

function getPopouts() {
  const config = readConfig();
  // Drop entries whose camera no longer exists.
  const ids = new Set(config.cameras.map((c) => c.id));
  return (config.popouts || []).filter((p) => ids.has(p.cameraId));
}

function setPopouts(popouts) {
  const config = readConfig();
  config.popouts = popouts;
  writeConfig(config);
}

module.exports = {
  configPath,
  listCameras,
  getCamera,
  upsertCamera,
  removeCamera,
  getActiveCameraId,
  setActiveCameraId,
  getWindowState,
  setWindowState,
  getPopouts,
  setPopouts,
};
