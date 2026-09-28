// Resolve the bundled ffmpeg binary.
//
// ffmpeg-static resolves to a path inside app.asar when packaged, and files
// inside an asar archive cannot be executed. The build unpacks it (see
// forge.config.js asar.unpack), so the real binary lives in
// app.asar.unpacked - rewrite the path to point there.

const fs = require("node:fs");

let cached = null;

function ffmpegPath() {
  if (cached) return cached;

  let binary = require("ffmpeg-static");

  if (binary && binary.includes("app.asar")) {
    const unpacked = binary.replace("app.asar", "app.asar.unpacked");
    if (fs.existsSync(unpacked)) {
      binary = unpacked;
    }
  }

  cached = binary;
  return cached;
}

// Verify the binary is present and executable before relying on it.
//
// On Linux the execute bit can be missing: ffmpeg-static's download does not
// set it, and a package built on a filesystem without POSIX permissions cannot
// record it. Restore it rather than failing, since the alternative is an app
// that installs cleanly and then cannot stream anything.
function ffmpegAvailable() {
  try {
    const binary = ffmpegPath();
    if (!binary || !fs.existsSync(binary)) return false;

    try {
      fs.accessSync(binary, fs.constants.X_OK);
    } catch {
      if (process.platform === "win32") return false;
      fs.chmodSync(binary, 0o755);
      fs.accessSync(binary, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { ffmpegPath, ffmpegAvailable };
