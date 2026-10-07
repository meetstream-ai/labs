/**
 * AudioIn: the server side of `live_audio_required: { websocket_url }`.
 *
 * The bot connects to your WebSocket, sends a JSON handshake
 * `{ type: "ready", bot_id, message }`, then streams binary frames:
 *
 *   ┌──────────┬────────────┬────────────┬──────────────┬──────────────┬─────────────────┐
 *   │ msg_type │ sid_length │ speaker_id │ sname_length │ speaker_name │ pcm_audio_data  │
 *   │ 1 byte   │ 2 bytes LE │ L1 bytes   │ 2 bytes LE   │ L2 bytes     │ remaining bytes │
 *   └──────────┴────────────┴────────────┴──────────────┴──────────────┴─────────────────┘
 *
 * msg_type is 0x01 for PCM audio. The payload is signed 16-bit PCM, little-endian,
 * 48 kHz, mono, with no container. `speaker_name` is the literal string
 * "NoSpeaker" when MeetStream cannot attribute the audio to anyone.
 *
 * On top of that this class does simple energy-based turn detection: RMS above a
 * threshold starts an utterance, and a gap of silence ends it. That is enough to
 * know *when* somebody is talking and when they have stopped, which is what the
 * agent loop needs for barge-in. It is not speech recognition: the words come
 * from the live transcription webhook.
 */

const MSG_TYPE_PCM = 0x01;
const SAMPLE_RATE = 48000;
const BYTES_PER_SAMPLE = 2;

export class AudioIn {
  /**
   * @param {{
   *   logger: any,
   *   rmsThreshold?: number,
   *   silenceMs?: number,
   *   onSpeechStart?: (info: { speaker: string }) => void,
   *   onUtterance?: (info: { speaker: string, speakerId: string, seconds: number, peakRms: number }) => void
   * }} options
   */
  constructor({ logger, rmsThreshold = 500, silenceMs = 900, onSpeechStart, onUtterance }) {
    this.logger = logger;
    this.rmsThreshold = rmsThreshold;
    this.silenceMs = silenceMs;
    this.onSpeechStart = onSpeechStart ?? (() => {});
    this.onUtterance = onUtterance ?? (() => {});

    /** @type {Map<string, { name: string, speaking: boolean, lastVoiceAt: number, bytes: number, peakRms: number }>} */
    this.speakers = new Map();
    this.totalBytes = 0;
    this.sweep = null;
  }

  attach(ws) {
    this.logger.success("Live audio WebSocket connected");
    this.sweep = setInterval(() => this.#closeFinishedTurns(), 250);

    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          this.#onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } else {
          const msg = JSON.parse(data.toString("utf8"));
          if (msg.type === "ready") {
            this.logger.detail(`Live audio handshake from bot ${msg.bot_id}`);
          }
        }
      } catch (err) {
        this.logger.error("Bad live-audio frame", err);
      }
    });

    ws.on("close", (code) => {
      clearInterval(this.sweep);
      this.sweep = null;
      this.logger.info(`Live audio WebSocket closed (code ${code})`);
    });

    ws.on("error", (err) => this.logger.error("Live audio WebSocket error", err));
  }

  stop() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  // ── Frame parsing ─────────────────────────────────────────────────────────

  #onFrame(buf) {
    if (buf.length < 5) return;

    let offset = 0;
    const msgType = buf.readUInt8(offset);
    offset += 1;
    if (msgType !== MSG_TYPE_PCM) {
      this.logger.detail(`Ignoring frame with msg_type 0x${msgType.toString(16)}`);
      return;
    }

    const sidLen = buf.readUInt16LE(offset);
    offset += 2;
    if (offset + sidLen + 2 > buf.length) return;
    const speakerId = buf.toString("utf8", offset, offset + sidLen);
    offset += sidLen;

    const nameLen = buf.readUInt16LE(offset);
    offset += 2;
    if (offset + nameLen > buf.length) return;
    const speakerName = buf.toString("utf8", offset, offset + nameLen);
    offset += nameLen;

    const pcm = buf.subarray(offset);
    if (pcm.length < BYTES_PER_SAMPLE) return;

    this.totalBytes += pcm.length;

    // "NoSpeaker" means MeetStream could not attribute this audio. Keep the bytes
    // in the totals but never treat it as somebody taking a turn.
    const name = speakerName.trim() || "Unidentified";
    if (name === "NoSpeaker") return;

    const id = speakerId.trim() || name;
    this.#track(id, name, pcm);
  }

  #track(id, name, pcm) {
    const rms = rmsOf(pcm);
    const now = Date.now();

    let state = this.speakers.get(id);
    if (!state) {
      state = { name, speaking: false, lastVoiceAt: 0, bytes: 0, peakRms: 0 };
      this.speakers.set(id, state);
    }
    state.name = name;

    if (rms < this.rmsThreshold) return;

    if (!state.speaking) {
      state.speaking = true;
      state.bytes = 0;
      state.peakRms = 0;
      this.onSpeechStart({ speaker: name });
    }

    state.lastVoiceAt = now;
    state.bytes += pcm.length;
    state.peakRms = Math.max(state.peakRms, rms);
  }

  /** A speaker who has been quiet for silenceMs has finished their turn. */
  #closeFinishedTurns() {
    const now = Date.now();
    for (const [id, state] of this.speakers) {
      if (!state.speaking) continue;
      if (now - state.lastVoiceAt < this.silenceMs) continue;

      state.speaking = false;
      const seconds = state.bytes / BYTES_PER_SAMPLE / SAMPLE_RATE;
      const peakRms = state.peakRms;
      state.bytes = 0;
      state.peakRms = 0;

      // Ignore coughs, keyboard clicks and other sub-300ms blips.
      if (seconds < 0.3) continue;

      this.onUtterance({ speaker: state.name, speakerId: id, seconds, peakRms });
    }
  }
}

function rmsOf(buf) {
  const samples = Math.floor(buf.length / BYTES_PER_SAMPLE);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = buf.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}
