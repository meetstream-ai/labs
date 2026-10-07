/**
 * Loading audio for the `sendaudio` command.
 *
 * The control channel accepts exactly one audio shape: raw PCM, signed 16-bit,
 * little-endian, 48000 Hz, mono, base64-encoded, with no container and no WAV
 * header. Nothing is resampled here: a file in the wrong format is rejected
 * with the ffmpeg command that fixes it, because silently sending 44.1 kHz audio
 * as if it were 48 kHz produces chipmunk playback that is confusing to debug.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

const CONVERT_HINT =
  "Convert it with:\n" +
  "  ffmpeg -i <input> -f s16le -acodec pcm_s16le -ar 48000 -ac 1 output.pcm";

/**
 * @param {string} path .wav (PCM16/48k/mono) or headerless .pcm / .raw
 * @returns {{ pcm: Buffer, seconds: number, source: string }}
 */
export function loadPcm(path) {
  const buf = readFileSync(path);

  if (buf.length === 0) throw new Error(`${path} is empty.`);

  const isWav = buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF";
  const pcm = isWav ? extractWavPcm(buf, path) : asRawPcm(buf, path);

  return {
    pcm,
    seconds: pcm.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
    source: isWav ? "wav" : "raw",
  };
}

function asRawPcm(buf, path) {
  const ext = extname(path).toLowerCase();
  if (ext !== ".pcm" && ext !== ".raw") {
    throw new Error(
      `${path} is not a WAV file and does not have a .pcm/.raw extension, so its ` +
      `format cannot be verified.\n${CONVERT_HINT}`
    );
  }
  if (buf.length % BYTES_PER_SAMPLE !== 0) {
    throw new Error(`${path} has an odd byte count: that is not valid 16-bit PCM.`);
  }
  return buf;
}

/** Walk the RIFF chunk list rather than assuming the canonical 44-byte header. */
function extractWavPcm(buf, path) {
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is RIFF but not WAVE.`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      if (body + 16 > buf.length) throw new Error(`${path} has a truncated fmt chunk.`);
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }

    // Chunks are word-aligned: an odd size is followed by one pad byte.
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new Error(`${path} has no fmt chunk.`);
  if (!data) throw new Error(`${path} has no data chunk.`);

  const problems = [];
  if (fmt.audioFormat !== 1) problems.push(`encoding is not uncompressed PCM (format ${fmt.audioFormat})`);
  if (fmt.channels !== CHANNELS) problems.push(`${fmt.channels} channels, need mono`);
  if (fmt.sampleRate !== SAMPLE_RATE) problems.push(`${fmt.sampleRate} Hz, need ${SAMPLE_RATE} Hz`);
  if (fmt.bitsPerSample !== BITS_PER_SAMPLE) problems.push(`${fmt.bitsPerSample}-bit, need ${BITS_PER_SAMPLE}-bit`);

  if (problems.length > 0) {
    throw new Error(`${path} is the wrong format: ${problems.join("; ")}.\n${CONVERT_HINT}`);
  }

  if (data.length % BYTES_PER_SAMPLE !== 0) {
    return data.subarray(0, data.length - (data.length % BYTES_PER_SAMPLE));
  }
  return data;
}
