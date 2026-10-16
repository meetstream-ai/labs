/**
 * MeetStream Labs — Real-Time Video Streaming (WebSocket)
 * video-ws-server.js
 *
 * Receives live video from a MeetStream bot over a persistent WebSocket
 * connection. MeetStream streams fragmented MP4 (fMP4) data you can record
 * or process in real time.
 *
 * Endpoints:
 *   WS   /video              — MeetStream streams video here
 *   GET  /health             — health check
 *   GET  /sessions/:botId    — view recording metadata for a session
 *
 * Usage:
 *   node video-ws-server.js
 */

const express = require("express");
const http = require("http");
const { createWriteStream } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const { join } = require("node:path");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());

const OUT_DIR = process.env.OUTPUT_DIR || join(process.cwd(), "recordings");

// ─── In-memory session store ─────────────────────────────────────────────────
// Keyed by bot_id. Holds recording metadata.
// Replace with a real DB for production.
const sessions = {};

function getSession(botId) {
  if (!sessions[botId]) {
    sessions[botId] = { recordings: [] };
  }
  return sessions[botId];
}

// ─── Stream event handlers ───────────────────────────────────────────────────
function onStreamStart({ bot_id, msg, outPath, speakerId, speakerName }) {
  const speaker = speakerId ? ` | ${speakerName ?? '?'} (${speakerId})` : '';
  console.log(
    `▶ [${bot_id}] Recording started → ${outPath} (${msg.width}x${msg.height} @ ${msg.framerate}fps, ${msg.codec}/${msg.audio_codec})${speaker}`
  );
}

function onStreamComplete({ bot_id, duration_seconds, bytesWritten, outPath, custom_attributes, speakerId, speakerName }) {
  const speaker = speakerId ? ` | ${speakerName ?? '?'} (${speakerId})` : '';
  console.log(
    `✓ [${bot_id}] Recording complete (${duration_seconds ?? "?"}s, ${formatBytes(bytesWritten)}) → ${outPath}${speaker}`
  );
  console.log(
    `[onStreamComplete] bot=${bot_id} | custom=${JSON.stringify(custom_attributes ?? {})}`
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function finalizeRecording(ws) {
  if (!ws.writeStream) return;

  ws.writeStream.end();
  ws.writeStream = null;

  if (ws.recordingMeta) {
    ws.recordingMeta.endedAt = new Date().toISOString();
    ws.recordingMeta.bytesWritten = ws.bytesWritten;
    onStreamComplete({
      bot_id: ws.botId,
      duration_seconds: ws.recordingMeta.durationSeconds,
      bytesWritten: ws.bytesWritten,
      outPath: ws.recordingMeta.outPath,
      custom_attributes: ws.customAttributes,
      speakerId: ws.recordingMeta.speakerId,
      speakerName: ws.recordingMeta.speakerName,
    });
  }
}

function handleVideoMessage(ws, raw, isBinary) {
  if (isBinary) {
    if (!ws.writeStream) return;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    ws.bytesWritten += buf.length;
    ws.writeStream.write(buf);
    return;
  }

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.warn("Ignoring non-JSON WebSocket message");
    return;
  }

  switch (msg.type) {
    case "video_stream_start": {
      ws.botId = msg.bot_id || "unknown";
      ws.speakerId = msg.speakerId;
      ws.speakerName = msg.speakerName;
      const outPath = join(OUT_DIR, `${ws.botId}_${Date.now()}.mp4`);
      ws.writeStream = createWriteStream(outPath);
      ws.bytesWritten = 0;

      ws.recordingMeta = {
        botId: ws.botId,
        speakerId: msg.speakerId ?? undefined,
        speakerName: msg.speakerName ?? undefined,
        outPath,
        codec: msg.codec,
        audioCodec: msg.audio_codec,
        container: msg.container,
        width: msg.width,
        height: msg.height,
        framerate: msg.framerate,
        audioSampleRate: msg.audio_sample_rate,
        audioBitrate: msg.audio_bitrate,
        startedAt: new Date().toISOString(),
        bytesWritten: 0,
      };

      getSession(ws.botId).recordings.push(ws.recordingMeta);
      onStreamStart({ bot_id: ws.botId, msg, outPath, speakerId: ws.speakerId, speakerName: ws.speakerName });
      break;
    }

    case "video_latency_ping": {
      ws.send(
        JSON.stringify({
          type: "video_latency_pong",
          seq: msg.seq,
          sent_at_ms: msg.sent_at_ms,
          server_received_at_ms: Date.now(),
          bot_id: msg.bot_id || ws.botId,
        })
      );
      break;
    }

    case "video_stream_end": {
      if (ws.recordingMeta) {
        ws.recordingMeta.durationSeconds = msg.duration_seconds;
      }
      console.log(
        `■ [${ws.botId}] Stream ended (${msg.duration_seconds ?? "?"}s)`
      );
      finalizeRecording(ws);
      break;
    }

    default:
      console.warn(`Unknown message type: ${msg.type}`);
  }
}

// ─── HTTP endpoints ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    transport: "video-websocket",
    outputDir: OUT_DIR,
    sessions: Object.keys(sessions).length,
    wsClients: wss.clientSet.size,
  });
});

app.get("/sessions/:botId", (req, res) => {
  const session = sessions[req.params.botId];
  if (!session) {
    return res.status(404).json({ error: "No session found for that bot_id" });
  }
  res.json(session);
});

// ─── WebSocket server ────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/video",
  maxPayload: 64 * 1024 * 1024, // 64 MB — video chunks can be large
});
wss.clientSet = new Set();

wss.on("connection", (ws, req) => {
  wss.clientSet.add(ws);
  ws.botId = null;
  ws.speakerId = null;
  ws.speakerName = null;
  ws.writeStream = null;
  ws.bytesWritten = 0;
  ws.recordingMeta = null;
  ws.customAttributes = null;

  console.log(`WebSocket client connected (${req.socket.remoteAddress})`);

  ws.on("message", (raw, isBinary) => {
    handleVideoMessage(ws, raw, isBinary);
  });

  ws.on("close", () => {
    wss.clientSet.delete(ws);
    finalizeRecording(ws);
    console.log("WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;

async function start() {
  await mkdir(OUT_DIR, { recursive: true });

  server.listen(PORT, () => {
    console.log(`\nMeetStream live video WebSocket server on :${PORT}`);
    console.log(`  WS   /video               → receives fMP4 video stream`);
    console.log(`  GET  /health              → health check`);
    console.log(`  GET  /sessions/:botId     → view recording metadata`);
    console.log(`  Output                    → ${OUT_DIR}\n`);
    console.log(`Next: expose publicly with ngrok http ${PORT}\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
