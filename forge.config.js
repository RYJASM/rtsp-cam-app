const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Forge does not expose the target platform to the config, so read it from the
// command line. Only needed to decide whether the fuses plugin can run.
const targetsDarwin = process.argv.some(
  (a, i) => a === '--platform' ? process.argv[i + 1] === 'darwin'
                               : a === '--platform=darwin'
);
const crossBuildingForDarwin = targetsDarwin && process.platform !== 'darwin';

// Identify an executable from its magic number, so a build cannot silently
// ship a binary for the wrong platform. macOS and Linux both name the file
// "ffmpeg", which makes that mistake easy and invisible until the app runs.
function binaryKind(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    if (head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return 'linux';
    if (head.readUInt32BE(0) === 0xcffaedfe) {
      // Mach-O 64-bit, little-endian. cputype distinguishes the architecture.
      return head.readUInt32LE(4) === 0x0100000c ? 'darwin-arm64' : 'darwin-x64';
    }
    if (head[0] === 0x4d && head[1] === 0x5a) return 'win32';   // "MZ"
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ffmpeg-static downloads one binary per platform at install time, named
// ffmpeg.exe on Windows and ffmpeg elsewhere. Several can be present when
// cross-building, so drop the one the target cannot run, confirm the survivor
// really is for that target, and make sure it is executable - the download does
// not set the bit, and the app refuses to start a stream without it.
function prepareFfmpeg(buildPath, platform, arch) {
  const dir = path.join(buildPath, 'node_modules', 'ffmpeg-static');
  if (!fs.existsSync(dir)) return;

  const wanted = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const unwanted = platform === 'win32' ? 'ffmpeg' : 'ffmpeg.exe';

  for (const suffix of ['', '.LICENSE', '.README']) {
    const stale = path.join(dir, unwanted + suffix);
    if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });
  }

  const binary = path.join(dir, wanted);
  const expected = platform === 'darwin' ? `darwin-${arch}` : platform;

  // Fetch the right binary if it is missing or belongs to another platform.
  // ffmpeg-static skips the download when a file of the same name is already
  // present, so a stale one has to be removed first - macOS and Linux both
  // call it "ffmpeg", which is exactly how the wrong one gets shipped.
  if (!fs.existsSync(binary) || binaryKind(binary) !== expected) {
    fs.rmSync(binary, { force: true });
    const installer = path.join(
      __dirname, 'node_modules', 'ffmpeg-static', 'install.js'
    );
    // The installer skips the download when a file of that name already
    // exists, so clear the project's copy too - otherwise a stale binary for
    // another platform silently satisfies the check.
    const projectBinary = path.join(
      __dirname, 'node_modules', 'ffmpeg-static', wanted
    );
    if (fs.existsSync(projectBinary) && binaryKind(projectBinary) !== expected) {
      fs.rmSync(projectBinary, { force: true });
    }
    execFileSync(process.execPath, [installer], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_platform: platform,
        npm_config_arch: arch,
      },
    });
    // The installer writes into the project, not this staged copy.
    const fetched = path.join(__dirname, 'node_modules', 'ffmpeg-static', wanted);
    if (!fs.existsSync(fetched)) {
      throw new Error(`Could not fetch the ffmpeg binary for ${expected}.`);
    }
    fs.copyFileSync(fetched, binary);
  }

  const kind = binaryKind(binary);
  if (kind !== expected) {
    throw new Error(
      `ffmpeg binary is for ${kind}, but this build targets ${expected}.`
    );
  }

  if (platform !== 'win32') fs.chmodSync(binary, 0o755);
}

module.exports = {
  packagerConfig: {
    // ffmpeg must stay outside the archive: binaries inside app.asar cannot
    // be executed. src/ffmpeg-path.js redirects to the unpacked copy.
    asar: {
      unpack: "**/node_modules/ffmpeg-static/**",
    },
    // Keep build output and dev-only files out of the shipped app.
    ignore: [
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/.*\.md$/,
    ],
    afterCopy: [
      (buildPath, electronVersion, platform, arch, callback) => {
        try {
          prepareFfmpeg(buildPath, platform, arch);
          callback();
        } catch (err) {
          callback(err);
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      // macOS ships as a .zip: a .dmg maker needs macOS-only tooling.
      // Windows also gets a portable .zip alongside the Squirrel installer.
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    // No maker-rpm: it aborts the whole run on any machine without rpmbuild,
    // which includes a stock Ubuntu/WSL box. Add it back if RPMs are needed,
    // and install rpm alongside it.
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application.
    //
    // Packaging for Apple Silicon re-signs the binary with codesign, which
    // only exists on macOS, so the plugin cannot run when cross-building for
    // darwin from another OS. Skipping it still produces a working package;
    // build on a Mac to get the fuses applied.
    ...(crossBuildingForDarwin ? [] : [
      new FusesPlugin({
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
      }),
    ]),
  ],
};
