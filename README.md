# rtsp-cam-app

A small, frameless desktop viewer for RTSP IP cameras. Keep a live camera feed
floating on top of your work, pinned behind everything as a "live wallpaper",
or anywhere in between.

Built with Electron. ffmpeg is bundled, so there is nothing else to install.

## Features

- **Multiple cameras** — save as many cameras as you like and switch between
  them from the viewer.
- **Pop-out windows** — open any camera in its own window and watch several at
  once. Window positions, sizes and settings are restored on the next launch.
- **Window levels** — the pin button cycles each window through *always on
  top*, *always at the bottom* (behind other apps) and *normal*.
- **See-through mode** — a translucent window you can keep over other work.
- **Snapshots** — save the current frame as a PNG.
- **Low latency** — the camera's H.264 stream is passed through without
  re-encoding and decoded with the hardware-accelerated WebCodecs API.
- **Auto-recovery** — stalled or dropped streams reconnect on their own.
- **Passwords kept secure** — camera passwords are encrypted with the operating
  system's keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux)
  and never written to the plain config file.

## Install

Download the latest build for your platform from the
[Releases](https://github.com/RYJASM/rtsp-cam-app/releases) page:

| Platform | File | Notes |
| --- | --- | --- |
| Windows | `rtsp-cam-app-<version> Setup.exe` | Run it; the app installs and launches. |
| Linux | `rtsp-cam-app_<version>_amd64.deb` | `sudo dpkg -i <file>`, then `sudo apt-get install -f` |
| macOS (Apple Silicon) | `rtsp-cam-app-darwin-arm64-<version>.zip` | Unzip and move to Applications. See below. |

The macOS build is unsigned, so Gatekeeper will block it the first time.
Right-click the app and choose **Open**, or run:

```bash
xattr -cr /Applications/rtsp-cam-app.app
```

## Usage

On first launch the settings window opens automatically. Add a camera with:

| Field | Example | Notes |
| --- | --- | --- |
| Name | Front door | Any label. |
| Host | 192.168.1.55 | The camera's IP address or hostname. |
| Port | 554 | The standard RTSP port. |
| Path | /stream1 | Varies by camera; check its manual. |
| Username / Password | | Leave blank if the camera has no login. |
| Transport | TCP | TCP is recommended; UDP may show artifacts. |

The camera must send **H.264** video. H.265/HEVC streams are not supported —
if your camera offers both, choose H.264 in its settings (the substream is
usually a good choice for a small window).

### Controls

Hover over a viewer to show its control bar:

| Button | Action |
| --- | --- |
| Camera name | Switch camera, or open settings |
| Pin | Cycle window level: top → bottom → normal |
| Eye | Toggle see-through mode |
| Arrow | Open this camera in a new window |
| Trash | Close this window and forget it (on the main window, quits) |
| Camera icon | Save a snapshot |
| − / × | Minimize / quit |

Drag anywhere on the video to move the window. **Esc** quits and saves the
layout of every open window.

### Where settings are stored

| OS | Location |
| --- | --- |
| Windows | `%APPDATA%\rtsp-cam-app` |
| macOS | `~/Library/Application Support/rtsp-cam-app` |
| Linux | `~/.config/rtsp-cam-app` |

`config.json` holds the camera list and window layout; `secrets.bin` holds the
encrypted passwords.

## Development

Requires Node.js 18 or later.

```bash
git clone https://github.com/RYJASM/rtsp-cam-app.git
cd rtsp-cam-app
npm install
npm start
```

To build installers, see [BUILDING.md](BUILDING.md).

### How it works

For each camera being watched, the main process runs ffmpeg to pull the RTSP
stream and copy the raw H.264 out without re-encoding. It relays that over a
local WebSocket (`ws://localhost:9999/<cameraId>`) to the viewer windows, which
decode it with `VideoDecoder` and draw it to a canvas. Streams are
reference-counted, so several windows showing the same camera share a single
ffmpeg process.

| File | Role |
| --- | --- |
| `src/index.js` | Main process: windows, window levels, IPC |
| `src/stream.js` | ffmpeg processes and the WebSocket relay |
| `src/config.js` | Camera list and layout persistence |
| `src/credentials.js` | Encrypted password storage |
| `src/ffmpeg-path.js` | Locates the bundled ffmpeg binary |
| `src/index.html` | Viewer window |
| `src/settings.html` | Camera settings window |

## License

MIT
