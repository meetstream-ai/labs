const test = require("node:test");
const assert = require("node:assert/strict");
const { readWav, resample, pcmToWav, decodeToPcm, ffmpegPath } = require("../src/audio");

const tone = (rate, seconds, hz = 440) => {
  const s = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return s;
};
const pcm16 = (samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), i * 2));
  return b;
};

test("the WAV reader averages channels and reads 24-bit PCM", () => {
  // Stereo 24-bit, 3 frames: left/right pairs.
  const frames = [[0.5, -0.5], [0.25, 0.25], [-1, 0]];
  const data = Buffer.alloc(frames.length * 6);
  frames.flat().forEach((v, i) => data.writeIntLE(Math.round(v * 8388607), i * 3, 3));
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10); fmt.writeUInt32LE(8000, 12);
  fmt.writeUInt32LE(8000 * 6, 16); fmt.writeUInt16LE(6, 20); fmt.writeUInt16LE(24, 22);
  const head = Buffer.alloc(12); head.write("RIFF", 0); head.writeUInt32LE(4 + 24 + 8 + data.length, 4); head.write("WAVE", 8);
  const dataHead = Buffer.alloc(8); dataHead.write("data", 0); dataHead.writeUInt32LE(data.length, 4);
  const { samples, rate } = readWav(Buffer.concat([head, fmt, dataHead, data]));
  assert.equal(rate, 8000);
  assert.deepEqual([...samples].map((v) => +v.toFixed(3)), [0, 0.25, -0.5]);
});

test("anything that isn't WAV is refused with a clear message", () => {
  assert.throws(() => readWav(Buffer.from("ID3 not a wav file at all")), /Not a WAV file/);
});

test("resampling keeps a tone's pitch, level and length", () => {
  for (const [from, to] of [[16000, 48000], [22050, 48000], [48000, 16000]]) {
    const out = resample(tone(from, 2), from, to);
    assert.equal(out.length, to * 2);
    let crossings = 0, peak = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
    for (let i = to / 4; i < out.length - to / 4; i++) peak = Math.max(peak, Math.abs(out[i]));
    assert.ok(Math.abs(crossings / 2 / 2 - 440) < 2, `${from}→${to}: ${crossings / 4} Hz`);
    assert.ok(Math.abs(peak - 0.5) < 0.01, `${from}→${to}: peak ${peak}`);
  }
});

test("the built-in decoder matches ffmpeg", { skip: !ffmpegPath && "ffmpeg not installed" }, async () => {
  const wav = pcmToWav(pcm16(tone(16000, 1.5, 1000)), 16000);
  const viaFfmpeg = await decodeToPcm(wav, 48000);
  const builtin = resample(readWav(wav).samples, 16000, 48000);
  assert.equal(builtin.length, viaFfmpeg.length / 2);
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < builtin.length; i++) {
    const x = viaFfmpeg.readInt16LE(i * 2) / 32768, y = builtin[i];
    dot += x * y; a += x * x; b += y * y;
  }
  assert.ok(dot / Math.sqrt(a * b) > 0.9999, `correlation ${dot / Math.sqrt(a * b)}`);
});
