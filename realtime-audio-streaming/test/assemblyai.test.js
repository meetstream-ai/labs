import test from "node:test";
import assert from "node:assert/strict";
import assemblyai, { parseMessage, CHUNK_BYTES } from "../src/providers/assemblyai.js";

const OPEN = 1;

function fakeSocket() {
  const sent = [];
  return {
    sent,
    readyState: OPEN,
    closed: false,
    send(m) { sent.push(m); },
    close() { this.closed = true; },
  };
}

test("parseMessage: reads v3 Turn messages, not v2 PartialTranscript/FinalTranscript", () => {
  assert.equal(parseMessage({ message_type: "FinalTranscript", text: "hello" }), null);
  assert.equal(parseMessage({ type: "Begin", id: "x" }), null);
  assert.equal(parseMessage({ type: "Turn", transcript: "  " }), null);
  assert.equal(parseMessage(null), null);
});

test("parseMessage: only the formatted end-of-turn message is final", () => {
  assert.equal(parseMessage({ type: "Turn", end_of_turn: false, transcript: "hello the" }).isFinal, false);
  assert.equal(
    parseMessage({ type: "Turn", end_of_turn: true, turn_is_formatted: false, transcript: "hello there" }).isFinal,
    false,
  );
  assert.deepEqual(
    parseMessage({
      type: "Turn", end_of_turn: true, turn_is_formatted: true,
      transcript: "Hello there.", end_of_turn_confidence: 0.9,
    }),
    { text: "Hello there.", isFinal: true, meta: { confidence: 0.9 } },
  );
});

test("sendAudio: batches 20 ms frames into 100 ms binary chunks", () => {
  const socket = fakeSocket();
  Object.assign(assemblyai, { socket, _pending: [], _pendingBytes: 0 });
  const frame = Buffer.alloc(1920); // 20 ms of PCM16 mono at 48 kHz

  for (let i = 0; i < 4; i++) assemblyai.sendAudio(frame);
  assert.equal(socket.sent.length, 0, "under 100 ms is held back");

  assemblyai.sendAudio(frame);
  assert.equal(socket.sent.length, 1);
  assert.ok(Buffer.isBuffer(socket.sent[0]), "audio is sent as binary, not base64 JSON");
  assert.equal(socket.sent[0].length, CHUNK_BYTES);
});

test("disconnect: sends the remaining audio, then Terminate, and waits for Termination", async () => {
  const socket = fakeSocket();
  Object.assign(assemblyai, { socket, _pending: [], _pendingBytes: 0 });
  assemblyai.sendAudio(Buffer.alloc(1920));

  const closing = assemblyai.disconnect();
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[0].length, 1920);
  assert.deepEqual(JSON.parse(socket.sent[1]), { type: "Terminate" });
  assert.equal(socket.closed, false, "waits for AssemblyAI before closing");

  assemblyai._terminated(); // what the Termination message handler calls
  await closing;
  assert.equal(socket.closed, true);
});
