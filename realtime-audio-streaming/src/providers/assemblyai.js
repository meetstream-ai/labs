/**
 * AssemblyAI provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Free tier: https://www.assemblyai.com/dashboard/signup
 * Env required: ASSEMBLYAI_API_KEY
 *
 * Streams raw PCM to AssemblyAI's Universal-Streaming (v3) endpoint.
 *
 * v3 differs from the older v2 realtime API in ways that matter here:
 *   - audio goes up as binary frames, not base64 JSON;
 *   - results come back as { type: "Turn", transcript, end_of_turn, words }
 *     rather than PartialTranscript / FinalTranscript;
 *   - each audio message must hold 50–1000 ms of audio, so the small frames
 *     /stream delivers are batched into 100 ms chunks before sending;
 *   - the session is ended with { type: "Terminate" }.
 */

import { WebSocket } from "ws";

const SAMPLE_RATE = 48000;
const ASSEMBLYAI_URL =
  "wss://streaming.assemblyai.com/v3/ws" +
  `?sample_rate=${SAMPLE_RATE}&encoding=pcm_s16le&format_turns=true`;

// 100 ms of PCM16 mono at 48 kHz.
const CHUNK_BYTES = SAMPLE_RATE * 2 * 0.1;

/**
 * Turns one v3 message into what onResult needs, or null if it carries no
 * transcript. With format_turns=true AssemblyAI sends each finished turn twice,
 * unformatted then formatted; only the formatted one is final, so a finished
 * turn is not counted twice.
 */
export function parseMessage(msg) {
  if (msg?.type !== "Turn" || !msg.transcript?.trim()) return null;
  const isFinal = Boolean(msg.end_of_turn && msg.turn_is_formatted);
  const lastWord = msg.words?.[msg.words.length - 1];
  return {
    text: msg.transcript,
    isFinal,
    meta: {
      confidence: msg.end_of_turn_confidence,
      // Where this turn ends in the audio stream, in seconds.
      audioEnd: typeof lastWord?.end === "number" ? lastWord.end / 1000 : undefined,
    },
  };
}

export default {
  name: "AssemblyAI (speech-to-text)",

  async connect(onResult) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing ASSEMBLYAI_API_KEY. Sign up free: https://www.assemblyai.com/dashboard/signup"
      );
    }

    this._pending = [];
    this._pendingBytes = 0;

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(ASSEMBLYAI_URL, {
        headers: { Authorization: apiKey },
      });

      this.socket.on("open", () => resolve());

      this.socket.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "Termination") {
          this._terminated?.();
          return;
        }
        const result = parseMessage(msg);
        if (result) onResult(result.text, result.isFinal, result.meta);
      });

      this.socket.on("close", (code, reason) => {
        this._terminated?.();
        if (code !== 1000 && code !== 1005) {
          console.error(`  ✖ AssemblyAI closed the stream (${code}${reason?.length ? `: ${reason}` : ""})`);
        }
      });

      this.socket.on("error", (err) => reject(err));
    });
  },

  sendAudio(pcm) {
    this._pending.push(pcm);
    this._pendingBytes += pcm.length;
    if (this._pendingBytes >= CHUNK_BYTES) this._sendPending();
  },

  _sendPending() {
    if (!this._pendingBytes) return;
    const chunk = Buffer.concat(this._pending);
    this._pending = [];
    this._pendingBytes = 0;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
  },

  /**
   * Optional: called when the audio has ended, before disconnect(). Sends
   * what is still buffered and asks AssemblyAI to finish the last turn, then
   * waits (up to 10 s) for it to confirm, so no trailing words are lost.
   */
  async flush() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this._sendPending();
    const done = new Promise((resolve) => (this._terminated = resolve));
    this.socket.send(JSON.stringify({ type: "Terminate" }));
    await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);
  },

  async disconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this._sendPending();
      this.socket.send(JSON.stringify({ type: "Terminate" }));
      this.socket.close();
    }
  },
};
