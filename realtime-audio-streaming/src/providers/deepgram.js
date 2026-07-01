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

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen" +
  "?encoding=linear16&sample_rate=48000&channels=1" +
  "&punctuate=true&smart_format=true&interim_results=true";

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
          if (msg.type === "Results") {
            const alt = msg.channel?.alternatives?.[0];
            if (alt?.transcript?.trim()) {
              onResult(alt.transcript, msg.is_final, { confidence: alt.confidence });
            }
          }
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

  async disconnect() {
    this._reconnect?.stop();
    clearInterval(this._keepAliveTimer);
  },
};