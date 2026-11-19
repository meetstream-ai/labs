import test from "node:test";
import assert from "node:assert/strict";
import { parseMessage as assembly } from "../src/providers/assemblyai.js";
import { parseMessage as deepgram } from "../src/providers/deepgram.js";
import openai, { downsample2to1 } from "../src/providers/openai-whisper.js";

test("AssemblyAI v3: only the formatted end-of-turn message is final, timed by its last word", () => {
  const words = [{ text: "Hello", start: 100, end: 400 }, { text: "there", start: 450, end: 900 }];
  assert.equal(assembly({ type: "Turn", end_of_turn: false, transcript: "hello the", words }).isFinal, false);
  assert.equal(assembly({ type: "Turn", end_of_turn: true, turn_is_formatted: false, transcript: "hello there", words }).isFinal, false);
  const final = assembly({ type: "Turn", end_of_turn: true, turn_is_formatted: true, transcript: "Hello there.", words, end_of_turn_confidence: 0.9 });
  assert.deepEqual(final, { text: "Hello there.", isFinal: true, meta: { confidence: 0.9, audioEnd: 0.9 } });
  assert.equal(assembly({ type: "Begin", id: "x" }), null);
  assert.equal(assembly({ type: "Turn", transcript: "  " }), null);
});

test("Deepgram: final results are timed by start + duration", () => {
  const r = deepgram({ type: "Results", is_final: true, start: 1.5, duration: 2, channel: { alternatives: [{ transcript: "hi there", confidence: 0.9 }] } });
  assert.deepEqual(r, { text: "hi there", isFinal: true, meta: { confidence: 0.9, audioEnd: 3.5 } });
  assert.equal(deepgram({ type: "Metadata" }), null);
  assert.equal(deepgram({ type: "Results", channel: { alternatives: [{ transcript: "" }] } }), null);
});

test("OpenAI: 48 kHz is averaged down to 24 kHz", () => {
  const pcm = Buffer.alloc(8);
  [100, 300, -50, -150].forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  const out = downsample2to1(pcm);
  assert.deepEqual([out.readInt16LE(0), out.readInt16LE(2)], [200, -100]);
});

test("OpenAI: a turn is committed after half a second of silence and timed where the speech ended", () => {
  const sent = [];
  Object.assign(openai, {
    socket: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) },
    _sentSeconds: 0, _turnStart: 0, _silence: 0, _speech: false, _commitEnds: [], _pendingTurns: 0,
  });
  const frame = (amp) => {
    const b = Buffer.alloc(1920); // 20 ms at 48 kHz
    for (let i = 0; i < 960; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
    return b;
  };
  const commits = () => sent.filter((m) => m.type === "input_audio_buffer.commit").length;
  for (let i = 0; i < 50; i++) openai.sendAudio(frame(3000)); // 1 s of speech
  for (let i = 0; i < 24; i++) openai.sendAudio(frame(0));    // 0.48 s of silence: not yet
  assert.equal(commits(), 0);
  openai.sendAudio(frame(0));                                  // 0.5 s: commit
  assert.equal(commits(), 1);
  assert.equal(openai._commitEnds.length, 1);
  assert.ok(Math.abs(openai._commitEnds[0] - 1.0) < 1e-9, `${openai._commitEnds[0]}`);
  assert.equal(sent[0].type, "input_audio_buffer.append");
  assert.equal(Buffer.from(sent[0].audio, "base64").length, 960); // 20 ms at 24 kHz
});
