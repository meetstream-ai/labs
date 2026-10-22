/**
 * comparison.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends one audio stream to several providers at once and measures each:
 *
 *   - WER of its final transcripts against a reference (optional), scored
 *     exactly as ../transcription-provider-benchmark scores post-call
 *     transcripts (src/wer.js);
 *   - finalisation latency: for each final transcript, how long after its
 *     audio ended it arrived. Audio is fed in real time, so the moment a
 *     phrase's audio was sent is streamStart + its position in the stream;
 *   - end-of-stream latency: from the last audio sent to the provider's last
 *     final transcript (after asking it to flush).
 *
 * Every provider gets the same frames in the same order at the same moment,
 * through the same provider interface bridge.js uses.
 */

import { normalize, wer, clipWindow } from "./wer.js";

export const SAMPLE_RATE = 48000;

/** Reads a PCM16 WAV file into mono PCM16 at its own sample rate. */
export function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file (convert it first: ffmpeg -i in.mp3 -ac 1 -ar 48000 out.wav)");
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("only 16-bit PCM WAV is supported");
      const data = buf.subarray(body, body + size);
      if (fmt.channels === 1) return { sampleRate: fmt.sampleRate, pcm: Buffer.from(data) };
      // Mix down to mono.
      const frames = Math.floor(data.length / (2 * fmt.channels));
      const mono = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
        mono.writeInt16LE(Math.round(sum / fmt.channels), i * 2);
      }
      return { sampleRate: fmt.sampleRate, pcm: mono };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

/** Linear-interpolation resample of mono PCM16 to 48 kHz, the /stream rate. */
export function resampleTo48k(pcm, rate) {
  if (rate === SAMPLE_RATE) return pcm;
  const inN = pcm.length >> 1;
  const outN = Math.floor((inN * SAMPLE_RATE) / rate);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = (i * rate) / SAMPLE_RATE;
    const j = Math.floor(pos);
    const a = pcm.readInt16LE(Math.min(j, inN - 1) * 2);
    const b = pcm.readInt16LE(Math.min(j + 1, inN - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (pos - j)), i * 2);
  }
  return out;
}

/**
 * Feeds `pcm` (48 kHz mono PCM16) to `send` in 20 ms frames, paced against the
 * wall clock so it arrives at real-time speed, as it would from a meeting.
 */
export async function replay(pcm, send, { frameMs = 20, speed = 1 } = {}) {
  const frameBytes = (SAMPLE_RATE * 2 * frameMs) / 1000;
  const start = Date.now();
  for (let i = 0, off = 0; off < pcm.length; i++, off += frameBytes) {
    send(pcm.subarray(off, off + frameBytes));
    const nextAt = start + ((i + 1) * frameMs) / speed;
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/**
 * @param {object}   opts
 * @param {{ key: string, impl: object }[]} opts.providers  modules from src/providers/
 * @param {(send: (pcm: Buffer, speaker?: string) => void) => Promise<void>} opts.feed
 *        pushes the audio; resolves when the audio has ended
 * @param {string}  [opts.reference]  what was actually said, for WER
 * @param {number}  [opts.graceMs]    extra wait after flushing for late finals
 * @param {(line: string) => void} [opts.log]
 */
export async function runComparison({ providers, feed, reference, graceMs = 2000, log = () => {} }) {
  const lanes = [];
  await Promise.all(providers.map(async ({ key, impl }) => {
    const lane = { key, name: impl.name, finals: [], interims: 0, error: null, connected: false };
    lanes.push(lane);
    try {
      await impl.connect((text, isFinal, meta = {}) => {
        if (!isFinal) { lane.interims++; return; }
        lane.finals.push({ text, at: Date.now(), audioEnd: meta.audioEnd ?? null });
      });
      lane.connected = true;
      log(`  ✔ ${key} connected`);
    } catch (err) {
      lane.error = err.message;
      log(`  ✖ ${key} not run: ${err.message}`);
    }
  }));

  const live = lanes.filter((l) => l.connected);
  const impls = new Map(providers.map((p) => [p.key, p.impl]));
  let streamStart = null;
  let lastSentAt = null;
  let bytes = 0;

  await feed((pcm, speaker = "Unidentified Speaker") => {
    if (streamStart === null) streamStart = Date.now();
    lastSentAt = Date.now();
    bytes += pcm.length;
    for (const lane of live) impls.get(lane.key).sendAudio(pcm, speaker);
  });

  const audioSeconds = bytes / 2 / SAMPLE_RATE;
  log(`  audio ended after ${audioSeconds.toFixed(1)}s; asking providers to finish`);
  await Promise.all(live.map((l) => impls.get(l.key).flush?.().catch(() => {})));
  await new Promise((r) => setTimeout(r, graceMs));
  await Promise.all(live.map((l) => impls.get(l.key).disconnect().catch(() => {})));

  const ref = reference ? normalize(reference) : null;
  const rows = lanes.map((lane) => {
    if (!lane.connected) return { provider: lane.key, name: lane.name, ran: false, reason: lane.error };
    const text = lane.finals.map((f) => f.text).join(" ");
    const latencies = lane.finals
      .filter((f) => typeof f.audioEnd === "number")
      .map((f) => +((f.at - streamStart) / 1000 - f.audioEnd).toFixed(3));
    const lastFinal = lane.finals.length ? lane.finals[lane.finals.length - 1].at : null;
    const row = {
      provider: lane.key,
      name: lane.name,
      ran: true,
      finals: lane.finals.length,
      interims: lane.interims,
      transcript: text,
      latency_median_s: median(latencies),
      latency_p90_s: percentile(latencies, 90),
      latency_samples: latencies.length,
      end_of_stream_s: lastFinal && lastSentAt ? +Math.max(0, (lastFinal - lastSentAt) / 1000).toFixed(3) : null,
      segments: lane.finals.map((f) => ({ text: f.text, audio_end_s: f.audioEnd, arrived_s: +((f.at - streamStart) / 1000).toFixed(3) })),
    };
    if (ref) {
      const window = clipWindow(ref, normalize(text));
      const r = wer(ref, window.hypothesis);
      Object.assign(row, {
        wer: r.wer,
        substitutions: r.substitutions,
        deletions: r.deletions,
        insertions: r.insertions,
        reference_words: r.referenceWords,
        outside_clip_words: window.before + window.after,
        errors: r.alignment.filter((a) => a.op !== "="),
      });
    }
    return row;
  });
  rows.sort((a, b) => (a.ran === b.ran ? (a.wer ?? 0) - (b.wer ?? 0) : a.ran ? -1 : 1));
  return { audio_seconds: +audioSeconds.toFixed(3), scored: Boolean(ref), providers: rows };
}

const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const secs = (x) => (x == null ? "–" : `${x.toFixed(2)}s`);

export function renderMarkdown(result, { source }) {
  const L = [];
  L.push(`# Live provider comparison`, "");
  L.push(`- Source: ${source}, ${result.audio_seconds}s of audio, sent to every provider at once in real time`);
  L.push(`- Latency: time from the end of a phrase's audio to its final transcript arriving (median / p90 over phrases), and from the last audio to the last final`);
  L.push("");
  const head = result.scored
    ? "| Provider | WER | Sub / Del / Ins | Latency (median) | Latency (p90) | After end of audio | Finals |"
    : "| Provider | Latency (median) | Latency (p90) | After end of audio | Finals |";
  const columns = head.split("|").length - 2;
  L.push(head, "|---|" + "---:|".repeat(columns - 1));
  for (const r of result.providers) {
    if (!r.ran) {
      L.push(result.scored ? `| ${r.provider} | not run | | | | | |` : `| ${r.provider} | not run | | | |`);
      continue;
    }
    const lat = `${secs(r.latency_median_s)} | ${secs(r.latency_p90_s)} | ${secs(r.end_of_stream_s)} | ${r.finals}`;
    L.push(result.scored
      ? `| ${r.provider} | ${pct(r.wer)} | ${r.substitutions} / ${r.deletions} / ${r.insertions} | ${lat} |`
      : `| ${r.provider} | ${lat} |`);
  }
  const notRun = result.providers.filter((r) => !r.ran);
  if (notRun.length) {
    L.push("", "## Not run", "");
    for (const r of notRun) L.push(`- **${r.provider}**: ${r.reason}`);
  }
  if (result.scored) {
    L.push("", "## Errors by provider", "");
    for (const r of result.providers.filter((x) => x.ran)) {
      const shown = r.errors.slice(0, 40).map((e) => (e.op === "S" ? `S ${e.ref}→${e.hyp}` : e.op === "D" ? `D ${e.ref}` : `I ${e.hyp}`));
      L.push(`**${r.provider}** (${r.errors.length} errors)${shown.length ? ": " + shown.map((s) => `\`${s}\``).join(", ") : ""}${r.errors.length > 40 ? ", …" : ""}`, "");
    }
  }
  return L.join("\n") + "\n";
}
