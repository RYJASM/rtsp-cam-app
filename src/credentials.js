// Camera passwords, encrypted at rest via the OS keychain.
//
// Electron's safeStorage uses DPAPI on Windows, Keychain on macOS and
// libsecret on Linux. Ciphertext is kept in its own file so the readable
// config.json never contains a secret.

const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const secretsPath = path.join(app.getPath("userData"), "secrets.bin");

function readStore() {
  try {
    const blob = fs.readFileSync(secretsPath);
    if (blob.length === 0) return {};
    const json = safeStorage.decryptString(blob);
    return JSON.parse(json);
  } catch {
    // Unreadable or undecryptable (e.g. copied to another machine or user
    // profile). Treat as empty; the user is re-prompted for the password.
    return {};
  }
}

function writeStore(store) {
  const blob = safeStorage.encryptString(JSON.stringify(store));
  const tmp = secretsPath + ".tmp";
  fs.writeFileSync(tmp, blob);
  fs.renameSync(tmp, secretsPath);
}

// True when the OS can actually encrypt. On Linux without a keyring daemon
// this is false, and callers must not persist secrets.
function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function setPassword(cameraId, password) {
  if (!isAvailable()) return false;
  const store = readStore();
  if (password) {
    store[cameraId] = password;
  } else {
    delete store[cameraId];
  }
  writeStore(store);
  return true;
}

function getPassword(cameraId) {
  if (!isAvailable()) return "";
  return readStore()[cameraId] || "";
}

function hasPassword(cameraId) {
  return Boolean(getPassword(cameraId));
}

function deletePassword(cameraId) {
  if (!isAvailable()) return;
  const store = readStore();
  delete store[cameraId];
  writeStore(store);
}

module.exports = {
  isAvailable,
  setPassword,
  getPassword,
  hasPassword,
  deletePassword,
};
