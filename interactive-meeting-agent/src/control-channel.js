/**
 * ControlChannel: the bring-your-own bridge for `socket_connection_url`.
 *
 * When a bot is created with:
 *
 *   "socket_connection_url": { "websocket_url": "wss://you/control" }
 *
 * it connects to YOUR WebSocket server as a client once it is in the meeting and
 * sends a handshake:
 *
 *   { "type": "ready", "bot_id": "bot_abc123", "message": "Ready to receive messages" }
 *
 * From then on the channel is one-way command traffic: you send JSON objects with
 * a `command` field and a `bot_id`, and the bot performs them in the meeting.
 * The socket closes with code 1000 when the bot leaves.
 *
 * This is your own server. It is not a MeetStream-hosted bridge, and it is not
 * how MIA works: a MIA bot is created with `agent_config_id` alone and never
 * with socket_connection_url or live_audio_required.
 *
 * ── The commands ────────────────────────────────────────────────────────────
 *
 *   sendaudio     play audio through the bot's microphone
 *                 { command, bot_id, audiochunk (base64 PCM16 LE), sample_rate,
 *                   encoding, channels, endianness }
 *
 *   sendmsg       chat message. `message` AND `msg` must carry the same value:
 *                 different meeting platforms read different keys.
 *                 { command, bot_id, message, msg }
 *
 *   sendchat      chat message with a role and streaming support
 *                 { command, bot_id, role: "assistant"|"user", text, is_final }
 *
 *   interrupt     stop queued audio playback
 *                 { command, bot_id, action: "clear_audio_queue" }
 *                 Google Meet actually clears the queue. Zoom and Teams accept
 *                 the command but do not.
 *
 *   sendimg       set the bot's camera feed to a base64 JPEG/PNG
 *                 { command, bot_id, img }
 *
 *   sendimg_url   set the bot's camera feed to an image at a public URL
 *                 { command, bot_id, img_url }
 */

import { WebSocket } from "ws";
import { SAMPLE_RATE, BYTES_PER_SAMPLE } from "./pcm.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ControlChannel {
  constructor(logger) {
    this.logger = logger;
    this.ws = null;
    this.botId = null;
    this.ready = false;
    this.audioPlaying = false;
    this.cancelAudio = false;
    this.onReady = null;
    this.onClose = null;
  }

  get connected() {
    return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN && this.ready;
  }

  /** Wire up a bot socket that has just connected to our server. */
  attach(ws) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.logger.warn("A second bot connected to the control socket: closing the older one.");
      try {
        this.ws.close(1000, "replaced");
      } catch {
        /* already gone */
      }
    }

    this.ws = ws;
    this.ready = false;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // the control channel is JSON text only
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        this.logger.warn("Ignoring non-JSON frame on the control socket");
        return;
      }

      if (msg.type === "ready") {
        this.botId = msg.bot_id ?? this.botId;
        this.ready = true;
        this.logger.success(`Control channel ready: bot ${this.botId}`);
        this.onReady?.(this.botId);
      } else {
        this.logger.detail(`Control message: ${JSON.stringify(msg)}`);
      }
    });

    ws.on("close", (code, reason) => {
      this.ready = false;
      this.cancelAudio = true;
      const why = reason?.length ? ` (${reason.toString()})` : "";
      this.logger.info(`Control socket closed: code ${code}${why}`);
      this.onClose?.(code);
    });

    ws.on("error", (err) => this.logger.error("Control socket error", err));
  }

  /** Low-level send. Throws rather than silently dropping a command. */
  send(payload) {
    if (!this.connected) {
      throw new Error("Control channel is not connected: the bot has not sent its ready handshake yet.");
    }
    this.ws.send(JSON.stringify({ ...payload, bot_id: this.botId }));
  }

  // ── sendmsg ────────────────────────────────────────────────────────────────

  /** Both `message` and `msg` are set: platforms differ on which key they read. */
  sendMsg(text) {
    this.send({ command: "sendmsg", message: text, msg: text });
  }

  // ── sendchat ───────────────────────────────────────────────────────────────

  sendChat(text, { role = "assistant", isFinal = true } = {}) {
    this.send({ command: "sendchat", role, text, is_final: isFinal });
  }

  /**
   * Stream a message the way an LLM would emit it: repeated interim frames with
   * growing text, then one committed frame.
   */
  async streamChat(text, { role = "assistant", chunkChars = 12, delayMs = 120 } = {}) {
    let shown = "";
    for (let i = 0; i < text.length; i += chunkChars) {
      shown = text.slice(0, Math.min(i + chunkChars, text.length));
      this.sendChat(shown, { role, isFinal: false });
      await sleep(delayMs);
    }
    this.sendChat(text, { role, isFinal: true });
  }

  // ── interrupt ──────────────────────────────────────────────────────────────

  /**
   * Clears the bot's queued audio. Also cancels any sendAudio loop running in
   * this process, otherwise we would keep refilling the queue we just cleared.
   */
  interrupt() {
    this.cancelAudio = true;
    this.send({ command: "interrupt", action: "clear_audio_queue" });
  }

  // ── sendimg / sendimg_url ──────────────────────────────────────────────────

  sendImgBase64(base64) {
    this.send({ command: "sendimg", img: base64 });
  }

  sendImgUrl(url) {
    this.send({ command: "sendimg_url", img_url: url });
  }

  // ── sendaudio ──────────────────────────────────────────────────────────────

  /**
   * Play PCM through the bot's microphone.
   *
   * Audio is chunked and paced slightly faster than real time: sending a 1s chunk
   * every 0.8s keeps the bot's playback queue just ahead of the playhead, so there
   * are no gaps, without building an unbounded backlog that `interrupt` then has
   * to throw away.
   *
   * @param {Buffer} pcm raw PCM16 LE, 48 kHz, mono
   * @param {{ chunkMs?: number, pace?: number }} [options]
   * @returns {Promise<{ chunks: number, seconds: number, cancelled: boolean }>}
   */
  async sendAudio(pcm, { chunkMs = 500, pace = 0.8 } = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) {
      throw new Error("sendAudio needs a non-empty PCM buffer.");
    }
    if (this.audioPlaying) {
      throw new Error("Audio is already streaming. Use interrupt first.");
    }

    // Keep chunk boundaries on whole samples.
    let chunkBytes = Math.floor((SAMPLE_RATE * BYTES_PER_SAMPLE * chunkMs) / 1000);
    if (chunkBytes % BYTES_PER_SAMPLE !== 0) chunkBytes -= chunkBytes % BYTES_PER_SAMPLE;

    this.audioPlaying = true;
    this.cancelAudio = false;

    let chunks = 0;
    let sentBytes = 0;

    try {
      for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
        if (this.cancelAudio) break;
        if (!this.connected) throw new Error("Control channel dropped while streaming audio.");

        const slice = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));

        this.send({
          command: "sendaudio",
          audiochunk: slice.toString("base64"),
          sample_rate: SAMPLE_RATE,
          encoding: "pcm16",
          channels: 1,
          endianness: "little",
        });

        chunks++;
        sentBytes += slice.length;

        const sliceMs = (slice.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;
        await sleep(sliceMs * pace);
      }
    } finally {
      this.audioPlaying = false;
    }

    return {
      chunks,
      seconds: sentBytes / BYTES_PER_SAMPLE / SAMPLE_RATE,
      cancelled: this.cancelAudio,
    };
  }
}
