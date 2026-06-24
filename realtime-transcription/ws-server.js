/**
 * MeetStream Labs — Real-Time Transcription (WebSocket)
 * ws-server.js
 *
 * Receives live transcription events from MeetStream over a persistent
 * WebSocket connection. Use this when you need a long-lived stream you
 * can listen to, buffer, and reprocess — unlike one-shot webhook POSTs.
 *
 * Endpoints:
 *   WS   /ws                 — MeetStream streams transcription events here
 *   GET  /health             — health check
 *   GET  /sessions/:botId    — view committed transcript for a session
 *
 * Usage:
 *   node ws-server.js
 */

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.json());

// ─── In-memory session store ─────────────────────────────────────────────────
const sessions = {};

function getSession(botId) {
  if (!sessions[botId]) {
    sessions[botId] = { turns: [] };
  }
  return sessions[botId];
}

function formatSpeakerLabel(speakerId, speakerName) {
  const name = speakerName ?? "?";
  const id = speakerId ?? "?";
  return `${name} (${id})`;
}

// ─── Transcription event handler ─────────────────────────────────────────────
function handleTranscriptionEvent(event) {
  const {
    bot_id,
    speakerId,
    speakerName,
    new_text,
    transcript,
    end_of_turn,
    word_is_final,
    timestamp,
    custom_attributes,
  } = event;

  if (!bot_id) return;

  const session = getSession(bot_id);

  if (word_is_final && new_text) {
    const label = formatSpeakerLabel(speakerId, speakerName);
    process.stdout.write(`\r[LIVE] ${label}: ${transcript}   `);
  }

  if (end_of_turn && transcript) {
    const turn = {
      speakerId: speakerId ?? "unknown",
      speakerName: speakerName ?? "Unknown",
      text: transcript.trim(),
      timestamp: timestamp
        ? new Date(timestamp).toLocaleTimeString()
        : new Date().toLocaleTimeString(),
    };

    session.turns.push(turn);
    process.stdout.write("\n");
    console.log(
      `✓ [${bot_id}] ${formatSpeakerLabel(turn.speakerId, turn.speakerName)}: "${turn.text}"`
    );

    onTurnComplete({ bot_id, turn, custom_attributes });
  }
}

function onTurnComplete({ bot_id, turn, custom_attributes }) {
  console.log(
    `[onTurnComplete] bot=${bot_id} | custom=${JSON.stringify(custom_attributes ?? {})}`
  );
}

// ─── HTTP endpoints ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    transport: "websocket",
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
const wss = new WebSocketServer({ server, path: "/ws" });
wss.clientSet = new Set();

wss.on("connection", (ws, req) => {
  wss.clientSet.add(ws);
  console.log(`WebSocket client connected (${req.socket.remoteAddress})`);

  ws.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      console.warn("Ignoring non-JSON WebSocket message");
      return;
    }
    handleTranscriptionEvent(event);
  });

  ws.on("close", () => {
    wss.clientSet.delete(ws);
    console.log("WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\nMeetStream live transcription WebSocket server on :${PORT}`);
  console.log(`  WS   /ws                 → receives transcription events`);
  console.log(`  GET  /health             → health check`);
  console.log(`  GET  /sessions/:botId    → view session transcript\n`);
  console.log(`Next: expose publicly with ngrok http ${PORT}\n`);
});
