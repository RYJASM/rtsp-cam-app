# Building

## Windows

```bash
npm install
npm run make
```

Produces a Squirrel installer in `out/make/`.

## Linux (.deb)

The `.deb` **must be built on Linux** — `@electron-forge/maker-deb` shells out to
`dpkg` and `fakeroot`, which do not exist on Windows. Forge refuses the build
with *"the maker declared that it cannot run on win32"* rather than producing a
broken package.

WSL works fine for this. From a Windows machine:

```powershell
wsl --install -d Ubuntu     # once; needs a restart the first time
```

Then build inside it. Copy the source into the Linux filesystem rather than
building over `/mnt/c`: NTFS cannot store the execute bit, so ffmpeg would ship
without it.

```bash
wsl -d Ubuntu -u root -- bash -lc '
  apt-get update && apt-get install -y dpkg-dev fakeroot nodejs npm
  rm -rf /build && mkdir /build
  cd /mnt/c/path/to/rtsp-cam-app
  cp -r src package.json package-lock.json forge.config.js /build/
  cd /build
  npm install
  npm run make
'
```

Produces `/build/out/make/deb/x64/rtsp-cam-app_<version>_amd64.deb` (~117MB).

Install and test:

```bash
sudo dpkg -i rtsp-cam-app_1.0.0_amd64.deb
sudo apt-get install -f      # pulls any missing runtime libraries
rtsp-cam-app
```

### The ffmpeg binary

Handled automatically. `ffmpeg-static` ships one platform-specific binary,
named `ffmpeg.exe` on Windows and `ffmpeg` on both macOS and Linux — so the
wrong one is easy to ship by accident and invisible until the app runs.

An `afterCopy` hook in `forge.config.js` runs on every build and:

- identifies the staged binary by its magic number (PE / ELF / Mach-O, and the
  Mach-O CPU type for arm64 vs x64),
- downloads the correct one if it is missing or belongs to another platform,
- removes the binary the target cannot run,
- sets the execute bit.

No manual `npm_config_platform=...` step is needed. Note that a bundle staged on
NTFS cannot record POSIX permissions — the app restores the execute bit at
startup if it is missing, and packaging on Linux avoids the issue entirely.

## macOS (Apple Silicon)

Best built on a Mac:

```bash
npm install
npm run make -- --platform=darwin --arch=arm64
```

`npm install` fetches the arm64 ffmpeg, and the fuses plugin can re-sign the
binary, which it must do for Apple Silicon.

### Cross-building from Windows

Possible, with two caveats handled by the config:

```bash
npx electron-forge package --platform=darwin --arch=arm64
```

The correct ffmpeg is fetched automatically (see above).

1. **The fuses plugin is skipped.** Applying fuses to an arm64 build re-signs
   the binary with `codesign`, which only exists on macOS. `forge.config.js`
   detects the cross-build and omits the plugin; the app still runs, it just
   lacks the fuse hardening. Build on a Mac if you want those applied.

2. **The zip maker cannot be used.** `.app` bundles contain symlinks inside
   `Electron Framework.framework`, and the Windows zip implementation fails on
   them with *"Access to the path ... is denied"*. Archive from WSL instead,
   which preserves both symlinks and the execute bit:

   ```bash
   wsl -d Ubuntu -u root -- bash -lc '
     cd /mnt/c/path/to/rtsp-cam-app/out/rtsp-cam-app-darwin-arm64
     zip -qry ../make/zip/darwin/arm64/rtsp-cam-app-darwin-arm64-1.0.0.zip rtsp-cam-app.app
   '
   ```

### Unsigned app warning

The build is unsigned, so macOS Gatekeeper will refuse to open it. Either
right-click the app and choose Open, or clear the quarantine flag:

```bash
xattr -cr /Applications/rtsp-cam-app.app
```

Signing needs an Apple Developer account and must be done on macOS.

## Icons

No icon is configured yet. Add one to `packagerConfig` before distributing:

```js
packagerConfig: {
  icon: 'assets/icon',   // .ico on Windows, .png on Linux
}
```
