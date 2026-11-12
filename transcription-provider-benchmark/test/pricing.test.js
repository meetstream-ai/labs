const test = require("node:test");
const assert = require("node:assert/strict");
const { audioSeconds, costOf } = require("../src/pricing");
const { PROVIDERS } = require("../src/providers");

// The published Test 1 run: 257.19 s billed, JigsawStack reported 1969 tokens.
const seconds = 257.1947;

test("billed audio length comes from Deepgram's or AssemblyAI's raw response", () => {
  assert.equal(audioSeconds([null, { _usage: {} }, { metadata: { duration: seconds } }]), seconds);
  assert.equal(audioSeconds([{ audio_duration: 258 }]), 258);
  assert.equal(audioSeconds([null, {}]), null);
});

test("costs match the published rates for the Test 1 recording", () => {
  const at = (p, raw) => costOf(p, { seconds, raw, config: PROVIDERS[p] });
  const close = (a, b) => assert.ok(Math.abs(a - b) < 5e-5, `${a} vs ${b}`);
  close(at("meetstream").cost_usd, 0.0071);
  close(at("deepgram").cost_usd, 0.0184);
  close(at("assemblyai").cost_usd, 0.0121); // $0.15 + $0.02 speaker labels (on by default)
  close(at("sarvam").cost_usd, 0.0334);     // ₹45/hr with diarization (on by default)
  close(at("jigsawstack", { _usage: { total_tokens: 1969 } }).cost_usd, 0.0019);
  close(at("meetstream").per_hour_usd, 0.10);
});

test("turning speaker labels or diarization off uses the cheaper rate", () => {
  const a = costOf("assemblyai", { seconds: 3600, config: { assemblyai: { speaker_labels: false } } });
  assert.equal(a.cost_usd, 0.15);
  const s = costOf("sarvam", { seconds: 3600, config: { sarvam: { with_diarization: false } } });
  assert.ok(Math.abs(s.cost_usd - 30 / 96.16) < 1e-9);
});

test("unknown length or usage gives no cost rather than a guess", () => {
  assert.equal(costOf("deepgram", { seconds: null }).cost_usd, null);
  assert.equal(costOf("jigsawstack", { seconds, raw: {} }).cost_usd, null);
  assert.equal(costOf("nope", { seconds }), null);
});
