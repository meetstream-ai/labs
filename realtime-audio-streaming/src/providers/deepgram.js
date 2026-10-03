/**
 * Deepgram provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Free tier: https://console.deepgram.com/signup ($200 credit, no card)
 * Env required: DEEPGRAM_API_KEY
 *
 * Streams raw PCM straight through to Deepgram's real-time STT endpoint and
 * surfaces interim + final transcripts via onResult().
 *
 * Auto-reconnects with exponential backoff if the socket drops mid-meeting
 * (network blip, Deepgram-side restart, idle timeout, etc.) — see
 * reconnect-helper.js. Audio sent while reconnecting is dropped (logged),
 * not buffered — buffering live audio risks unbounded memory growth if the
 * outage is long; dropping a few seconds of transcript is the safer default.
 */

import { WebSocket } from "ws";
import { withReconnect } from "./reconnect-helper.js";

// model=nova-3: without it Deepgram streams with its legacy "base" model, which
// on the benchmark's sample clip scored 14.5% WER against Nova-3's 3.6%. Same
// model and language as the post-call benchmark, so the two are comparable.
const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3&language=en" +
  "&encoding=linear16&sample_rate=48000&channels=1" +
  "&punctuate=true&smart_format=true&interim_results=true";

/**
 * Turns one Deepgram message into what onResult needs, or null if it carries
 * no transcript. Results messages give their position in the audio stream as
 * start + duration (seconds), which the comparison uses for latency.
 */
export function parseMessage(msg) {
  if (msg?.type !== "Results") return null;
  const alt = msg.channel?.alternatives?.[0];
  if (!alt?.transcript?.trim()) return null;
  return {
    text: alt.transcript,
    isFinal: Boolean(msg.is_final),
    meta: {
      confidence: alt.confidence,
      audioEnd: typeof msg.start === "number" && typeof msg.duration === "number" ? msg.start + msg.duration : undefined,
    },
  };
}

export default {
  name: "Deepgram (speech-to-text)",

  framesDroppedWhileReconnecting: 0,

  async connect(onResult) {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing DEEPGRAM_API_KEY. Get a free key: https://console.deepgram.com/signup"
      );
    }

    this._logger = console; // bridge.js doesn't pass a logger in; plain console is fine here

    this._reconnect = withReconnect({
      logger: this._logger,

      openSocket: () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(DEEPGRAM_URL, {
            headers: { Authorization: `Token ${apiKey}` },
          });
          ws.once("open", () => resolve(ws));
          ws.once("error", reject);
        }),

      onOpen: (ws) => {
        console.log("  ✔ Deepgram socket (re)connected");

        this._keepAliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "KeepAlive" }));
          }
        }, 8000);

        ws.on("close", () => clearInterval(this._keepAliveTimer));

        ws.on("message", (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.from_finalize) this._finalized?.();
          const result = parseMessage(msg);
          if (result) onResult(result.text, result.isFinal, result.meta);
        });
      },

      onReconnecting: (msg) => console.log(`  ⚠ Deepgram: ${msg}`),

      onGiveUp: (err) => console.error(`  ✖ Deepgram: ${err.message} — giving up on reconnect`),
    });

    // Wait for the first connection before returning, so bridge.js knows
    // startup actually succeeded (subsequent drops reconnect silently in background).
    await new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const ws = this._reconnect.getSocket();
        if (ws?.readyState === WebSocket.OPEN) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); reject(new Error("Deepgram connect timed out")); }, 10000);
    });
  },

  sendAudio(pcm) {
    const ws = this._reconnect?.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(pcm);
    } else {
      // Socket is down and reconnecting — drop this frame rather than buffer it.
      this.framesDroppedWhileReconnecting++;
      if (this.framesDroppedWhileReconnecting % 50 === 1) {
        console.log(`  ⚠ Deepgram reconnecting — ${this.framesDroppedWhileReconnecting} frames dropped so far`);
      }
    }
  },

  /**
   * Optional: called when the audio has ended, before disconnect(). Asks
   * Deepgram to finalise whatever it is still holding, and waits (up to 10 s)
   * for that last result so no trailing words are lost.
   */
  async flush() {
    const ws = this._reconnect?.getSocket();
    if (ws?.readyState !== WebSocket.OPEN) return;
    const done = new Promise((resolve) => (this._finalized = resolve));
    ws.send(JSON.stringify({ type: "Finalize" }));
    await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);
  },

  async disconnect() {
    this._reconnect?.stop();
    clearInterval(this._keepAliveTimer);
  },
};