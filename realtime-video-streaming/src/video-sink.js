/**
 * VideoSink: the server side of `live_video_required: { websocket_url }`.
 *
 * The bot connects to your WebSocket as a client and speaks this protocol:
 *
 *   MS -> you   video_stream_start   JSON, once on connect. codec, audio_codec,
 *                                    container ("fmp4"), width, height, framerate,
 *                                    audio_sample_rate, audio_bitrate.
 *   MS -> you   <binary frames>      fMP4 chunks. Append in arrival order.
 *   MS -> you   video_latency_ping   JSON, periodic. seq, sent_at_ms.
 *   you -> MS   video_latency_pong   JSON. Echo seq + sent_at_ms, add
 *                                    server_received_at_ms and bot_id.
 *   MS -> you   video_stream_end     JSON, sent before close. duration_seconds.
 *
 * The pong is the keepalive contract. Every ping must be answered; a consumer that
 * stops answering looks dead to the sender. It is also how delivery latency is
 * measured, so answer immediately: before doing any other work with the message.
 *
 * Platform support: Google Meet and Microsoft Teams. Live video is NOT available
 * on Zoom.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

export class VideoSink {
  /**
   * @param {{ outputDir?: string, relay?: import("./relay.js").Relay|null, logger: any }} options
   */
  constructor({ outputDir = "./output", relay = null, logger }) {
    this.outputDir = outputDir;
    this.relay = relay;
    this.logger = logger;
    mkdirSync(outputDir, { recursive: true });
    this.#resetCounters();
  }

  #resetCounters() {
    this.botId = null;
    this.meta = null;
    this.file = null;
    this.filepath = null;
    this.bytes = 0;
    this.chunks = 0;
    this.pings = 0;
    this.latencySumMs = 0;
    this.lastLatencyMs = null;
    this.lastLogAt = 0;
    this.finished = false;
  }

  /**
   * Wire up a freshly connected bot socket.
   * @param {import("ws").WebSocket} ws
   * @param {{ onEnd?: Function }} [hooks]
   */
  attach(ws, hooks = {}) {
    this.logger.success("Bot video WebSocket connected");

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) this.#onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
        else this.#onText(ws, data);
      } catch (err) {
        this.logger.error("Failed to handle video frame", err);
      }
    });

    ws.on("close", (code, reason) => {
      const why = reason?.length ? ` (${reason.toString()})` : "";
      this.logger.info(`Bot video WebSocket closed: code ${code}${why}`);
      this.finalize();
      hooks.onEnd?.();
    });

    ws.on("error", (err) => this.logger.error("Bot video WebSocket error", err));
  }

  // ── Incoming text (control) messages ──────────────────────────────────────

  #onText(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      this.logger.warn(`Ignoring non-JSON text frame (${data.length} bytes)`);
      return;
    }

    switch (msg.type) {
      case "video_stream_start":
        this.#onStart(msg);
        break;
      case "video_latency_ping":
        this.#onPing(ws, msg);
        break;
      case "video_stream_end":
        this.#onStreamEnd(msg);
        break;
      default:
        this.logger.detail(`Unhandled control message: ${msg.type ?? "(no type field)"}`);
    }
  }

  #onStart(msg) {
    this.botId = msg.bot_id ?? this.botId;
    this.meta = msg;

    this.logger.success(
      `video_stream_start: ${msg.codec ?? "?"}/${msg.audio_codec ?? "?"} in ${msg.container ?? "?"} ` +
      `· ${msg.width ?? "?"}x${msg.height ?? "?"} @ ${msg.framerate ?? "?"}fps ` +
      `· audio ${msg.audio_sample_rate ?? "?"}Hz ${msg.audio_bitrate ?? "?"}`
    );

    this.#openFile();
    this.relay?.setStartMessage(msg);
  }

  /**
   * Answer the keepalive immediately. Echo seq and sent_at_ms exactly as received,
   * add our receive timestamp and the bot id.
   */
  #onPing(ws, msg) {
    const receivedAt = Date.now();

    const pong = {
      type: "video_latency_pong",
      seq: msg.seq,
      sent_at_ms: msg.sent_at_ms,
      server_received_at_ms: receivedAt,
      bot_id: msg.bot_id ?? this.botId,
    };

    try {
      ws.send(JSON.stringify(pong));
    } catch (err) {
      this.logger.error("Failed to send video_latency_pong: the bot may drop us", err);
      return;
    }

    this.pings++;
    if (typeof msg.sent_at_ms === "number") {
      // Wall-clock difference between two machines: useful as a trend, not as an
      // absolute, since it includes any clock skew between the bot and this host.
      this.lastLatencyMs = receivedAt - msg.sent_at_ms;
      this.latencySumMs += this.lastLatencyMs;
    }
  }

  #onStreamEnd(msg) {
    this.logger.info(
      `video_stream_end: ${msg.duration_seconds ?? "?"}s of video sent by the bot`
    );
    this.relay?.end(msg);
    this.finalize();
  }

  // ── Incoming binary (media) frames ────────────────────────────────────────

  #onBinary(chunk) {
    if (chunk.length === 0) return;

    // Defensive: if media somehow arrives before video_stream_start we still keep it.
    if (!this.file) {
      this.logger.warn("Binary chunk arrived before video_stream_start: opening output anyway");
      this.#openFile();
    }

    this.bytes += chunk.length;
    this.chunks++;

    this.file.write(chunk);
    this.relay?.broadcast(chunk);

    const now = Date.now();
    if (now - this.lastLogAt > 2000) {
      this.lastLogAt = now;
      const mb = (this.bytes / 1048576).toFixed(2);
      const latency = this.lastLatencyMs === null ? "-" : `${this.lastLatencyMs}ms`;
      const consumers = this.relay ? ` · ${this.relay.size} relay consumer(s)` : "";
      this.logger.info(
        `fMP4 ${mb} MB across ${this.chunks} chunks · last ping latency ${latency}${consumers}`
      );
    }
  }

  // ── Output file ───────────────────────────────────────────────────────────

  #openFile() {
    if (this.file) return;
    const name = `${this.botId ?? "bot"}-${Date.now()}.mp4`;
    this.filepath = join(this.outputDir, name);
    this.file = createWriteStream(this.filepath);
    this.file.on("error", (err) => this.logger.error(`Write failed for ${this.filepath}`, err));
    this.logger.info(`Writing fMP4 to ${this.filepath}`);
  }

  /** Idempotent: both video_stream_end and socket close call it. */
  finalize() {
    if (this.finished) return;
    this.finished = true;

    if (this.file) {
      this.file.end();
      const mb = (this.bytes / 1048576).toFixed(2);
      const avg = this.pings > 0 ? Math.round(this.latencySumMs / this.pings) : null;
      this.logger.success(
        `Saved ${this.filepath}: ${mb} MB, ${this.chunks} chunks, ` +
        `${this.pings} keepalive ping(s) answered${avg === null ? "" : `, avg latency ${avg}ms`}`
      );
      this.logger.detail("Play it with:  ffplay " + this.filepath);
    } else {
      this.logger.warn("No video data was received: nothing written.");
    }
  }
}
