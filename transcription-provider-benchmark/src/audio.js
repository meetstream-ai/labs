const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");

// ffmpeg comes with the command-line install (ffmpeg-static). The desktop
// build leaves it out (it's 80 MB) and decodes with the built-in WAV reader
// below instead: everything it plays is WAV (the sample clip, text-to-speech,
// and uploads, which the page converts to WAV before sending).
let ffmpegPath = null;
try {
  // In a packaged app a bundled binary is unpacked next to app.asar.
  ffmpegPath = require("ffmpeg-static")?.replace(/app\.asar([\\/])/, "app.asar.unpacked$1") ?? null;
  if (ffmpegPath && !fs.existsSync(ffmpegPath)) ffmpegPath = null;
} catch { /* not installed: built-in decoder only */ }
if (process.env.BENCH_NO_FFMPEG === "1") ffmpegPath = null; // tests exercise the built-in decoder

/** Which decoder decodeToPcm uses on this install. */
const decoder = () => (ffmpegPath ? "ffmpeg" : "builtin");

/**
 * Decodes audio to raw signed 16-bit little-endian mono PCM at `sampleRate`.
 * With ffmpeg: any format it understands (wav, flac, mp3, m4a, ...). Without:
 * WAV only (PCM 8/16/24/32-bit or 32/64-bit float, any channels and rate).
 *
 * @param {string|Buffer} input  A file path, or the encoded bytes themselves
 * @returns {Promise<Buffer>}
 */
function decodeToPcm(input, sampleRate) {
  if (!ffmpegPath) {
    return Promise.resolve().then(() => {
      const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input) : fs.readFileSync(input);
      const { samples, rate } = readWav(bytes);
      return floatToPcm16(resample(samples, rate, sampleRate));
    });
  }
  return new Promise((resolve, reject) => {
    const fromBuffer = Buffer.isBuffer(input) || input instanceof Uint8Array;
    const proc = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-i", fromBuffer ? "pipe:0" : input,
      "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRate),
      "pipe:1",
    ]);
    const out = [];
    let err = "";
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim()}`));
    });
    if (fromBuffer) proc.stdin.end(Buffer.from(input));
  });
}

/**
 * Reads a RIFF/WAVE file into mono float samples (channels averaged).
 * @returns {{ samples: Float32Array, rate: number }}
 */
function readWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file. This build plays WAV audio only: convert the file to WAV first.");
  }
  let fmt = null, data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      // Some writers leave the size at 0 or 0xFFFFFFFF while streaming: take the rest.
      data = buf.subarray(body, size && body + size <= buf.length ? body + size : buf.length);
      if (!size || size === 0xffffffff) break;
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error("WAV file has no fmt or data chunk.");
  const { format, channels, rate, bits } = fmt;
  const read = {
    "1:8": (o) => (data[o] - 128) / 128,
    "1:16": (o) => data.readInt16LE(o) / 32768,
    "1:24": (o) => data.readIntLE(o, 3) / 8388608,
    "1:32": (o) => data.readInt32LE(o) / 2147483648,
    "3:32": (o) => data.readFloatLE(o),
    "3:64": (o) => data.readDoubleLE(o),
  }[`${format}:${bits}`];
  if (!read || !channels || !rate) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit). Use 16-bit PCM WAV.`);
  const step = (bits / 8) * channels;
  const frames = Math.floor(data.length / step);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(i * step + (c * bits) / 8);
    samples[i] = sum / channels;
  }
  return { samples, rate };
}

/**
 * Band-limited resampling: a Blackman-windowed sinc, 16 zero crossings each
 * side, with the cutoff lowered to the output's Nyquist when downsampling.
 */
function resample(input, from, to) {
  if (from === to) return input;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(from, to);
  const up = to / g, down = from / g; // output n sits at input position n * down / up
  const cutoff = Math.min(1, to / from); // as a fraction of the input's Nyquist
  const zeros = 16;
  const half = Math.ceil(zeros / cutoff); // filter half-width, in input samples
  const taps = 2 * half;
  // One normalised kernel per fractional position: `up` of them, since
  // positions repeat every `up` outputs (3 for 16 kHz → 48 kHz).
  const kernelFor = (frac) => {
    const h = new Float32Array(taps);
    let norm = 0;
    for (let j = 0; j < taps; j++) {
      const x = (frac - (j - half + 1)) * cutoff; // distance in zero crossings
      if (Math.abs(x) >= zeros) continue;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / zeros) + 0.08 * Math.cos((2 * Math.PI * x) / zeros);
      h[j] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w;
      norm += h[j];
    }
    for (let j = 0; j < taps; j++) h[j] /= norm;
    return h;
  };
  const cache = up <= 4096 ? new Map() : null; // odd rates: compute each kernel as needed
  const out = new Float32Array(Math.round((input.length * up) / down));
  for (let n = 0; n < out.length; n++) {
    const pos = n * down;
    const centre = Math.floor(pos / up), phase = pos % up;
    let h = cache?.get(phase);
    if (!h) { h = kernelFor(phase / up); cache?.set(phase, h); }
    const first = centre - half + 1;
    let acc = 0;
    for (let j = Math.max(0, -first), end = Math.min(taps, input.length - first); j < end; j++) acc += input[first + j] * h[j];
    out[n] = acc;
  }
  return out;
}

function floatToPcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
  }
  return out;
}

/** Wraps mono s16le PCM in a WAV header. */
function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function sha256File(path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

/**
 * SHA-256 of a text file with its line endings made LF first, so the same
 * transcript hashes the same on a Windows checkout (CRLF) and a macOS or
 * Linux one (LF). Used for reference transcripts; audio uses sha256File.
 */
function textSha256(pathOrText, { isText = false } = {}) {
  const text = isText ? pathOrText : fs.readFileSync(pathOrText, "utf8");
  return crypto.createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex");
}

module.exports = { decodeToPcm, pcmToWav, readWav, resample, decoder, sha256File, textSha256, ffmpegPath };
