/**
 * OpenAI GPT-Realtime-Whisper provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Streaming speech-to-text via OpenAI's Realtime API, transcription mode.
 * Docs: https://platform.openai.com/docs/guides/realtime
 *
 * Env required: OPENAI_API_KEY
 *
 * This is a worked example of adding a NEW provider — copy this file's
 * shape for any other service. The only 3 things every provider implements
 * are connect(), sendAudio(), and disconnect() — see provider-interface.js.
 */

import { WebSocket } from "ws";

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?intent=transcription";

export default {
  name: "OpenAI GPT-Realtime-Whisper (speech-to-text)",

  async connect(onResult) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Missing OPENAI_API_KEY. Get one at https://platform.openai.com/api-keys"
      );
    }

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(OPENAI_REALTIME_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      this.socket.on("open", () => {
        // Configure the transcription session: tell OpenAI exactly what
        // format we're sending (PCM16, 48kHz handled server-side — OpenAI
        // resamples automatically) and which model to use.
        this.socket.send(JSON.stringify({
          type: "transcription_session.update",
          session: {
            input_audio_format: "pcm16",
            input_audio_transcription: { model: "gpt-realtime-whisper" },
            turn_detection: { type: "server_vad" },
          },
        }));
        resolve();
      });

      this.socket.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Live partial transcript
        if (msg.type === "conversation.item.input_audio_transcription.delta") {
          if (msg.delta?.trim()) onResult(msg.delta, false);
        }

        // Finalized transcript for a completed turn
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          if (msg.transcript?.trim()) onResult(msg.transcript, true);
        }
      });

      this.socket.on("error", (err) => reject(err));
    });
  },

  sendAudio(pcm) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      // OpenAI's Realtime API takes audio as base64-encoded JSON events,
      // not raw binary frames like Deepgram/AssemblyAI.
      this.socket.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      }));
    }
  },

  async disconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  },
};