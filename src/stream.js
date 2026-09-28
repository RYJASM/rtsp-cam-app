// Owns the ffmpeg processes and the WebSocket that carries H.264 to the
// renderers.
//
// Several cameras can stream at once (one per open window). Each camera gets
// its own ffmpeg process, and clients select a stream by connecting to
// ws://localhost:9999/<cameraId>. Streams are reference-counted: the last
// window to stop watching a camera shuts its ffmpeg process down.

const { spawn } = require("node:child_process");
const { WebSocketServer, WebSocket } = require("ws");
const credentials = require("./credentials");
const { ffmpegPath } = require("./ffmpeg-path");

const WS_PORT = 9999;

// NAL types carrying decoder configuration, and the IDR keyframe type.
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_IDR = 5;

let wsServer = null;
let statusListener = () => {};

// cameraId -> { camera, proc, initSegment, clients:Set, watchers:Set,
//               restartTimer, lastError, streaming }
const streams = new Map();

function onStatus(fn) {
  statusListener = fn;
}

function emit(cameraId, state, detail) {
  const entry = streams.get(cameraId);
  statusListener({
    state,
    detail: detail || null,
    cameraId,
    // Frame rate as reported by ffmpeg, so the viewer can pace playback.
    fps: entry ? entry.fps : undefined,
  });
}

// Build the RTSP URL. Credentials are percent-encoded so passwords containing
// @ : / or ! cannot corrupt the URL structure.
function buildUrl(camera, password) {
  const auth = camera.username
    ? `${encodeURIComponent(camera.username)}:${encodeURIComponent(password || "")}@`
    : "";
  const pathname = camera.pathname.startsWith("/")
    ? camera.pathname
    : "/" + camera.pathname;
  return `rtsp://${auth}${camera.host}:${camera.port}${pathname}`;
}

// Redact credentials before anything reaches a log or the UI.
function safeUrl(camera) {
  const pathname = camera.pathname.startsWith("/")
    ? camera.pathname
    : "/" + camera.pathname;
  return `rtsp://${camera.host}:${camera.port}${pathname}`;
}

function nalTypesIn(buffer) {
  const types = [];
  let i = 0;
  while (i + 3 < buffer.length) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) {
      i++;
      continue;
    }
    let offset;
    if (buffer[i + 2] === 1) {
      offset = i + 3;
    } else if (buffer[i + 2] === 0 && buffer[i + 3] === 1) {
      offset = i + 4;
    } else {
      i++;
      continue;
    }
    if (offset < buffer.length) {
      types.push(buffer[offset] & 0x1f);
    }
    i = offset;
  }
  return types;
}

function ensureServer() {
  if (wsServer) return;
  wsServer = new WebSocketServer({ port: WS_PORT });

  wsServer.on("connection", (client, request) => {
    // The path selects the camera: /<cameraId>
    const cameraId = decodeURIComponent((request.url || "/").slice(1));
    const entry = streams.get(cameraId);
    if (!entry) {
      client.close();
      return;
    }

    entry.clients.add(client);
    client.on("close", () => entry.clients.delete(client));

    // Bring a mid-stream client straight to a decodable state.
    if (entry.initSegment) client.send(entry.initSegment);
  });
}

// A client that cannot keep up (minimized, or on a busy machine) must not be
// allowed to accumulate an unbounded send backlog: that grows memory here and
// leaves the viewer playing further and further behind real time. Past the
// limit its queue is abandoned and it resyncs at the next keyframe, so it
// jumps to live rather than freezing.
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;

// How long a stream may produce nothing before it is considered stalled, and
// how often that is checked. Keyframes arrive every ~2s, so 10s of total
// silence is well beyond any normal gap.
const STALL_TIMEOUT_MS = 10000;
const STALL_CHECK_MS = 2000;

function broadcast(entry, data) {
  for (const client of entry.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    if (client.bufferedAmount > MAX_CLIENT_BACKLOG) {
      // Drop everything until the next keyframe, then start feeding again.
      client.__starving = true;
      continue;
    }

    if (client.__starving) {
      // Only a keyframe can restart a decoder cleanly.
      const types = nalTypesIn(data);
      if (!types.includes(NAL_IDR) && !types.includes(NAL_SPS)) continue;
      client.__starving = false;
    }

    client.send(data);
  }
}

// Translate ffmpeg's stderr into something a non-technical user can act on.
function describeFailure(lastError, camera) {
  const text = (lastError || "").toLowerCase();
  if (text.includes("401") || text.includes("unauthorized")) {
    return "Login failed - check the username and password.";
  }
  if (text.includes("404") || text.includes("not found")) {
    return `Stream path not found at ${safeUrl(camera)} - check the stream path.`;
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return `No response from ${camera.host} - check the address and that the camera is online.`;
  }
  if (text.includes("connection refused") || text.includes("no route")) {
    return `Cannot reach ${camera.host}:${camera.port}.`;
  }
  return lastError || "Stream stopped unexpectedly.";
}

function spawnFfmpeg(entry) {
  const camera = entry.camera;
  const password = credentials.getPassword(camera.id);
  const url = buildUrl(camera, password);

  entry.streaming = false;
  emit(camera.id, "connecting");

  const proc = spawn(ffmpegPath(), [
    // Emit packets as soon as they arrive instead of buffering for analysis;
    // without these ffmpeg holds frames back and delivery arrives in bursts.
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    // Enough for ffmpeg to work out the frame rate, which the viewer needs to
    // pace playback. With a tiny probesize it reports "not enough frames to
    // estimate rate" and omits the fps field entirely.
    "-probesize", "500000",
    "-analyzeduration", "1000000",
    // Cameras can stop sending without closing the TCP connection, leaving
    // ffmpeg blocked on a read forever. This socket I/O timeout (microseconds)
    // makes it fail instead, so the retry logic can reconnect.
    "-timeout", "5000000",
    "-rtsp_transport", camera.transport,
    "-i", url,
    // The camera already sends H.264, so stream copy avoids a re-encode:
    // no quality loss and negligible CPU.
    "-c:v", "copy",
    "-an",
    "-f", "h264",
    // Repeat SPS/PPS before every keyframe so clients can sync mid-stream.
    "-bsf:v", "dump_extra",
    "-",
  ]);
  entry.proc = proc;
  entry.lastError = "";

  proc.stdout.on("data", (data) => {
    entry.lastDataAt = Date.now();
    if (!entry.streaming) {
      entry.streaming = true;
      emit(camera.id, "streaming");
    }
    const types = nalTypesIn(data);
    if (types.includes(NAL_SPS) && types.includes(NAL_PPS) && types.includes(NAL_IDR)) {
      entry.initSegment = Buffer.from(data);
    }
    broadcast(entry, data);
  });

  // ffmpeg reports connection problems on stderr; keep the last line so the
  // UI can show why a camera failed instead of a blank screen.
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();

    // ffmpeg prints the stream's frame rate while opening the input. It is
    // authoritative, unlike anything the renderer could infer from arrival
    // times, which are far too bursty on RTSP to measure a rate from.
    if (entry.fps === undefined) {
      const match = text.match(/,\s*([0-9]+(?:\.[0-9]+)?)\s*fps\b/);
      if (match) {
        const fps = Number(match[1]);
        if (fps >= 1 && fps <= 120) {
          entry.fps = fps;
          emit(camera.id, entry.streaming ? "streaming" : "connecting");
        }
      }
    }

    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length) entry.lastError = lines[lines.length - 1];
  });

  proc.on("error", (err) => {
    emit(camera.id, "error", `Could not start ffmpeg: ${err.message}`);
  });

  // A camera can stop sending while leaving the TCP connection open, which
  // leaves ffmpeg blocked on a read: alive, using no CPU, producing nothing.
  // Nothing else notices, because the process never exits. Watch for silence
  // and restart it.
  entry.lastDataAt = Date.now();
  entry.stallTimer = setInterval(() => {
    if (entry.proc !== proc) return;
    if (Date.now() - entry.lastDataAt < STALL_TIMEOUT_MS) return;

    console.warn(
      `No data from ${safeUrl(camera)} for ${STALL_TIMEOUT_MS}ms - restarting`
    );
    entry.lastDataAt = Date.now();
    // Killing it triggers the close handler, which schedules the retry.
    try { proc.kill(); } catch {}
  }, STALL_CHECK_MS);

  proc.on("close", (code) => {
    if (entry.proc !== proc) return; // superseded by a newer spawn
    entry.proc = null;
    entry.streaming = false;
    if (entry.stallTimer) {
      clearInterval(entry.stallTimer);
      entry.stallTimer = null;
    }
    if (code === 0) return;

    emit(camera.id, "error", describeFailure(entry.lastError, camera));
    // Retry so a rebooting camera or brief network drop recovers on its own.
    entry.restartTimer = setTimeout(() => {
      if (streams.has(camera.id)) spawnFfmpeg(entry);
    }, 5000);
  });
}

function killProcess(entry) {
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
  if (entry.stallTimer) {
    clearInterval(entry.stallTimer);
    entry.stallTimer = null;
  }
  if (entry.proc) {
    const proc = entry.proc;
    entry.proc = null;
    proc.removeAllListeners("close");
    proc.kill();
  }
  entry.initSegment = null;
  entry.streaming = false;
}

// Begin (or join) a camera's stream on behalf of `watcher`, an opaque key
// identifying the window that wants it.
function acquire(camera, watcher) {
  ensureServer();

  let entry = streams.get(camera.id);
  if (entry) {
    entry.watchers.add(watcher);
    // Re-announce current state so a newly opened window is not left blank.
    if (entry.streaming) {
      emit(camera.id, "streaming");
    } else if (entry.proc) {
      emit(camera.id, "connecting");
    }
    return;
  }

  entry = {
    camera,
    proc: null,
    initSegment: null,
    clients: new Set(),
    watchers: new Set([watcher]),
    restartTimer: null,
    lastError: "",
    streaming: false,
  };
  streams.set(camera.id, entry);
  spawnFfmpeg(entry);
}

// Stop watching; the stream shuts down once nobody is left.
function release(cameraId, watcher) {
  const entry = streams.get(cameraId);
  if (!entry) return;

  entry.watchers.delete(watcher);
  if (entry.watchers.size > 0) return;

  killProcess(entry);
  for (const client of entry.clients) client.close();
  streams.delete(cameraId);
}

// Drop every stream held by a window, e.g. when it closes.
function releaseAll(watcher) {
  for (const cameraId of Array.from(streams.keys())) {
    release(cameraId, watcher);
  }
}

// Restart a camera in place, keeping its watchers (used after editing it).
function restart(camera) {
  const entry = streams.get(camera.id);
  if (!entry) return;
  entry.camera = camera;
  killProcess(entry);
  spawnFfmpeg(entry);
}

function statusOf(cameraId) {
  const entry = streams.get(cameraId);
  if (!entry) return { state: "idle", detail: null, cameraId };
  if (entry.streaming) return { state: "streaming", detail: null, cameraId, fps: entry.fps };
  if (entry.proc) return { state: "connecting", detail: null, cameraId, fps: entry.fps };
  return {
    state: "error",
    detail: describeFailure(entry.lastError, entry.camera),
    cameraId,
    fps: entry.fps,
  };
}

function shutdown() {
  for (const entry of streams.values()) {
    killProcess(entry);
    for (const client of entry.clients) client.close();
  }
  streams.clear();
  if (wsServer) {
    wsServer.close();
    wsServer = null;
  }
}

module.exports = {
  acquire,
  release,
  releaseAll,
  restart,
  statusOf,
  shutdown,
  onStatus,
  buildUrl,
  safeUrl,
  WS_PORT,
};
