/**
 * OpenAI realtime transcription provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Streaming speech-to-text via OpenAI's Realtime API in transcription mode,
 * with the gpt-live-transcribe model.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-transcription
 *
 * Env required: OPENAI_API_KEY
 *
 * (The file keeps its old name so STT_PROVIDER=openai-whisper still works.)
 *
 * What this has to do that Deepgram and AssemblyAI do not:
 *   - the session takes 24 kHz PCM, so the 48 kHz frames from /stream are
 *     downsampled 2:1 before sending;
 *   - gpt-live-transcribe has no server-side turn detection, so the client
 *     commits each turn itself: here, after ~0.5 s of silence following
 *     speech, or every 15 s at the latest;
 *   - the model returns no timestamps, so the audio position of each commit
 *     is remembered and attached to the transcript it produces.
 *
 * Built from OpenAI's docs as of 2026-09-28; not yet run against the live API.
 */

import { WebSocket } from "ws";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const IN_RATE = 48000;
const OUT_RATE = 24000;
const SILENCE_RMS = 500;          // PCM16 amplitude below which a frame counts as silence
const SILENCE_TO_COMMIT_S = 0.5;
const MAX_TURN_S = 15;

/** 48 kHz → 24 kHz PCM16 mono: average each pair of samples. */
export function downsample2to1(pcm) {
  const n = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.round((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 2), i * 2);
  }
  return out;
}

function rms(pcm) {
  let sum = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export default {
  name: "OpenAI gpt-live-transcribe (speech-to-text)",

  async connect(onResult) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY. Get one at https://platform.openai.com/api-keys");
    }

    this._sentSeconds = 0;       // audio position of everything sent so far
    this._turnStart = 0;
    this._silence = 0;
    this._speech = false;
    this._commitEnds = [];       // audio position of each commit, oldest first
    this._pendingTurns = 0;

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(OPENAI_REALTIME_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.socket.on("open", () => {
        this.socket.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: OUT_RATE },
                transcription: { model: "gpt-live-transcribe" },
                turn_detection: null,
              },
            },
          },
        }));
        resolve();
      });

      this.socket.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === "conversation.item.input_audio_transcription.delta") {
          if (msg.delta?.trim()) onResult(msg.delta, false);
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const audioEnd = this._commitEnds.shift();
          this._pendingTurns = Math.max(0, this._pendingTurns - 1);
          if (msg.transcript?.trim()) onResult(msg.transcript, true, { audioEnd });
          if (this._pendingTurns === 0) this._drained?.();
        }

        if (msg.type === "error") {
          console.error(`  ✖ OpenAI: ${msg.error?.message ?? JSON.stringify(msg)}`);
        }
      });

      this.socket.on("error", (err) => reject(err));
    });
  },

  sendAudio(pcm) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const seconds = pcm.length / 2 / IN_RATE;
    this.socket.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: downsample2to1(pcm).toString("base64"),
    }));
    this._sentSeconds += seconds;

    if (rms(pcm) >= SILENCE_RMS) {
      this._speech = true;
      this._silence = 0;
    } else {
      this._silence += seconds;
    }
    const turnLength = this._sentSeconds - this._turnStart;
    if ((this._speech && this._silence >= SILENCE_TO_COMMIT_S) || turnLength >= MAX_TURN_S) {
      this._commit();
    }
  },

  _commit() {
    if (!this._speech || this.socket?.readyState !== WebSocket.OPEN) {
      this._turnStart = this._sentSeconds;
      return;
    }
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    // The turn's speech ended where the trailing silence began.
    this._commitEnds.push(this._sentSeconds - this._silence);
    this._pendingTurns++;
    this._turnStart = this._sentSeconds;
    this._speech = false;
    this._silence = 0;
  },

  /**
   * Optional: called when the audio has ended, before disconnect(). Commits
   * the last turn and waits (up to 15 s) for every committed turn's
   * transcript, so no trailing words are lost.
   */
  async flush() {
    this._commit();
    if (!this._pendingTurns) return;
    const done = new Promise((resolve) => (this._drained = resolve));
    await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
  },

  async disconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  },
};
