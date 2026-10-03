import test from "node:test";
import assert from "node:assert/strict";
import { readWav, resampleTo48k, replay, runComparison, renderMarkdown, SAMPLE_RATE } from "../src/comparison.js";

function wav(samples, rate, channels = 1) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("readWav mixes stereo down to mono and resampleTo48k triples a 16 kHz clip", () => {
  const { sampleRate, pcm } = readWav(wav([100, 300, -200, 200], 16000, 2));
  assert.equal(sampleRate, 16000);
  assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2)], [200, 0]);
  const up = resampleTo48k(Buffer.from([0, 0, 100, 0]), 16000); // samples 0, 100
  assert.equal(up.length / 2, 6);
  assert.deepEqual([0, 1, 2, 3].map((i) => up.readInt16LE(i * 2)), [0, 33, 67, 100]);
  assert.throws(() => readWav(Buffer.from("not a wav file at all, definitely")), /not a WAV file/);
});

test("replay paces audio at real time", async () => {
  const pcm = Buffer.alloc(SAMPLE_RATE * 2 * 0.3); // 300 ms
  const frames = [];
  const start = Date.now();
  await replay(pcm, (f) => frames.push(f.length));
  const took = Date.now() - start;
  assert.equal(frames.length, 15); // 20 ms frames
  assert.ok(took >= 270 && took < 600, `took ${took}ms`);
});

/** A provider that finalises each phrase `delayMs` after its audio ends. */
function fakeProvider(name, phrases, delayMs) {
  return {
    name,
    async connect(onResult) { this.onResult = onResult; this.sent = 0; this.done = 0; },
    sendAudio(pcm) {
      this.sent += pcm.length / 2 / SAMPLE_RATE;
      while (this.done < phrases.length && this.sent >= phrases[this.done].end) {
        const p = phrases[this.done++];
        setTimeout(() => this.onResult(p.text, true, { audioEnd: p.end }), delayMs);
        this.onResult(p.text.split(" ")[0], false);
      }
    },
    async flush() {},
    async disconnect() {},
  };
}

test("runComparison scores every provider on the same audio and measures finalisation latency", async () => {
  const reference = "mister quilter is the apostle of the middle classes";
  const fast = fakeProvider("Fast", [{ text: "Mr. Quilter is the apostle", end: 0.2 }, { text: "of the middle classes.", end: 0.4 }], 50);
  const slow = fakeProvider("Slow", [{ text: "Mister Quilter is an apostle", end: 0.2 }, { text: "of the middle classes", end: 0.4 }], 250);
  const broken = { name: "Broken", async connect() { throw new Error("Missing BROKEN_API_KEY"); }, sendAudio() {}, async disconnect() {} };
  const pcm = Buffer.alloc(SAMPLE_RATE * 2 * 0.5);

  const result = await runComparison({
    providers: [{ key: "slow", impl: slow }, { key: "fast", impl: fast }, { key: "broken", impl: broken }],
    feed: (send) => replay(pcm, send),
    reference,
    graceMs: 400,
  });
  const by = Object.fromEntries(result.providers.map((r) => [r.provider, r]));

  assert.equal(by.fast.wer, 0);
  assert.equal(by.slow.wer, 1 / 9);
  assert.deepEqual(result.providers.map((r) => r.provider), ["fast", "slow", "broken"]);
  assert.equal(by.fast.finals, 2);
  assert.equal(by.fast.interims, 2);
  assert.ok(by.fast.latency_median_s >= 0.03 && by.fast.latency_median_s < 0.2, `fast ${by.fast.latency_median_s}`);
  assert.ok(by.slow.latency_median_s >= 0.22 && by.slow.latency_median_s < 0.45, `slow ${by.slow.latency_median_s}`);
  assert.equal(by.broken.ran, false);
  assert.match(by.broken.reason, /Missing BROKEN_API_KEY/);

  const md = renderMarkdown(result, { source: "test" });
  assert.match(md, /\| fast \| 0\.0% \| 0 \/ 0 \/ 0 \|/);
  assert.match(md, /\| broken \| not run \|/);
  assert.match(md, /`S the→an`/);
});

test("without a reference only latency is reported", async () => {
  const p = fakeProvider("P", [{ text: "hello", end: 0.1 }], 10);
  const result = await runComparison({
    providers: [{ key: "p", impl: p }],
    feed: (send) => replay(Buffer.alloc(SAMPLE_RATE * 2 * 0.2), send),
    graceMs: 100,
  });
  assert.equal(result.scored, false);
  assert.equal(result.providers[0].wer, undefined);
  assert.match(renderMarkdown(result, { source: "t" }), /^\| Provider \| Latency \(median\)/m);
});
