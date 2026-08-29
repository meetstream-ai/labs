/**
 * The Express server MeetStream posts to.
 *
 * Two separate endpoints, because they receive two different things:
 *
 *   POST /live      live transcript chunks, from
 *                   live_transcription_required.webhook_url
 *                   { speakerName, timestamp, transcript, words[] }
 *
 *   POST /webhook   bot lifecycle events, from callback_url
 *                   { event, bot_id, bot_status, message, status_code,
 *                     custom_attributes }
 *                   The envelope key is `event`.
 *
 * Both must ACK immediately. Do the work after responding - a slow handler
 * stalls the delivery pipeline.
 */

import express from "express";

/**
 * @param {object} options
 * @param {number} options.port
 * @param {(chunk: object) => void} options.onCaption
 * @param {(event: object) => void} options.onLifecycle
 * @param {() => void} [options.onReady]
 * @returns {import("http").Server}
 */
export function startServer({ port, onCaption, onLifecycle, onReady }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // ── Live transcript chunks ─────────────────────────────────────────────────
  app.post("/live", (req, res) => {
    res.status(200).json({ received: true });
    try {
      onCaption(req.body ?? {});
    } catch (err) {
      console.error(`Caption handler error: ${err.message}`);
    }
  });

  // ── Bot lifecycle events ───────────────────────────────────────────────────
  app.post("/webhook", (req, res) => {
    res.status(200).json({ received: true });
    try {
      onLifecycle(req.body ?? {});
    } catch (err) {
      console.error(`Lifecycle handler error: ${err.message}`);
    }
  });

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const server = app.listen(port, () => {
    if (onReady) onReady();
  });

  return server;
}

/**
 * Normalise a live transcript chunk.
 *
 * Documented shape:
 *   { speakerName, timestamp, transcript, words: [ { word, punctuated_word,
 *     start, end, confidence, speaker, speaker_confidence } ] }
 *
 * Some streaming providers additionally flag turn boundaries. When
 * `end_of_turn` is present and false the chunk is still being revised, so the
 * overlay replaces the in-progress line instead of committing a new one. When
 * the flag is absent every chunk is treated as final.
 */
export function normalizeChunk(chunk) {
  const text = typeof chunk?.transcript === "string" ? chunk.transcript.trim() : "";
  const final = chunk?.end_of_turn === false ? false : true;

  return {
    speaker: typeof chunk?.speakerName === "string" && chunk.speakerName.trim()
      ? chunk.speakerName.trim()
      : "Unknown",
    text,
    timestamp: typeof chunk?.timestamp === "string" ? chunk.timestamp : undefined,
    final,
    botId: typeof chunk?.bot_id === "string" ? chunk.bot_id : undefined,
  };
}
