/**
 * MeetStream Labs — Real-Time Transcription
 * server.js
 *
 * Receives live transcription events from MeetStream while the bot is in the meeting.
 *
 * Endpoints:
 *   POST /webhook          — MeetStream posts transcription events here
 *   GET  /health           — health check
 *   GET  /sessions/:botId  — view committed transcript for a session
 *
 * Usage:
 *   node server.js
 */

const express = require("express");

const app = express();
app.use(express.json());

// ─── In-memory session store ─────────────────────────────────────────────────
// Keyed by bot_id. Holds committed speaker turns.
// Replace with a real DB for production.
const sessions = {};

function getSession(botId) {
  if (!sessions[botId]) {
    sessions[botId] = { turns: [] };
  }
  return sessions[botId];
}

// ─── POST /webhook ────────────────────────────────────────────────────────────
// MeetStream posts a new event here for every word/phrase/turn while the bot
// is in the meeting.
app.post("/webhook", (req, res) => {
  // Always ACK immediately — MeetStream does not retry on timeout.
  res.sendStatus(200);

  const {
    bot_id,
    speakerId,
    speakerName,
    new_text,
    transcript,
    words = [],
    end_of_turn,
    word_is_final,
    timestamp,
    custom_attributes,
  } = req.body;

  if (!bot_id) return;

  const session = getSession(bot_id);

  // ── Live caption: print to stdout as words are finalized ──────────────────
  // word_is_final=false means the word may still change — treat as interim.
  // word_is_final=true means this word is locked in.
  if (word_is_final && new_text) {
    const label = formatSpeakerLabel(speakerId, speakerName);
    process.stdout.write(`\r[LIVE] ${label}: ${transcript}   `);
  }

  // ── Turn commit: speaker finished a complete thought ──────────────────────
  // end_of_turn=true is the signal to commit the full turn to your store.
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

    // Hand off to your downstream logic
    onTurnComplete({ bot_id, turn, custom_attributes });
  }
});

function formatSpeakerLabel(speakerId, speakerName) {
  const name = speakerName ?? "?";
  const id = speakerId ?? "?";
  return `${name} (${id})`;
}

// ─── onTurnComplete ──────────────────────────────────────────────────────────
// Called once per committed speaker turn.
// Add your own logic here: DB writes, LLM calls, SSE push, etc.
function onTurnComplete({ bot_id, turn, custom_attributes }) {
  // Examples:
  //   await db.insertTurn({ bot_id, ...turn });
  //   await callLLM(turn.text);
  //   sseClients.forEach(c => c.write(`data: ${JSON.stringify(turn)}\n\n`));
  console.log(
    `[onTurnComplete] bot=${bot_id} | custom=${JSON.stringify(custom_attributes ?? {})}`
  );
}

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: Object.keys(sessions).length });
});

// ─── GET /sessions/:botId ─────────────────────────────────────────────────────
app.get("/sessions/:botId", (req, res) => {
  const session = sessions[req.params.botId];
  if (!session) {
    return res.status(404).json({ error: "No session found for that bot_id" });
  }
  res.json(session);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nMeetStream live transcription server running on :${PORT}`);
  console.log(`  POST /webhook          → receives transcription events`);
  console.log(`  GET  /health           → health check`);
  console.log(`  GET  /sessions/:botId  → view session transcript\n`);
  console.log(`Next: expose publicly with ngrok http ${PORT}\n`);
});
