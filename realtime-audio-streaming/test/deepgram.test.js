import test from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../src/providers/deepgram.js";

test("Deepgram: final results are timed by start + duration", () => {
  const r = parseMessage({ type: "Results", is_final: true, start: 1.5, duration: 2, channel: { alternatives: [{ transcript: "hi there", confidence: 0.9 }] } });
  assert.deepEqual(r, { text: "hi there", isFinal: true, meta: { confidence: 0.9, audioEnd: 3.5 } });
  assert.equal(parseMessage({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hi" }] } }).isFinal, false);
  assert.equal(parseMessage({ type: "Metadata" }), null);
  assert.equal(parseMessage({ type: "Results", channel: { alternatives: [{ transcript: "" }] } }), null);
});
