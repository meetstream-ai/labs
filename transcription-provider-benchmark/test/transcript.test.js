const test = require("node:test");
const assert = require("node:assert/strict");
const { transcriptText, UnrecognizedTranscript } = require("../src/transcript");

test("documented shape: segments in time order, speakers dropped", () => {
  const data = [
    { speaker: "B", start_time: 4.2, transcript: "Second line." },
    { speaker: "A", start_time: 0.08, transcript: "First line," },
  ];
  assert.equal(transcriptText(data), "First line, Second line.");
});

test("documented shape without a transcript field falls back to words", () => {
  const data = [{ speaker: "A", start_time: 0, words: [{ word: "hello", punctuated_word: "Hello," }, { word: "there" }] }];
  assert.equal(transcriptText(data), "Hello, there");
});

test("observed shape: { message: [ { participant, words: [ { text } ] } ] }", () => {
  const data = {
    message: [
      { participant: { name: "A" }, words: [{ text: "one", start_timestamp: { relative: 1 } }, { text: "two" }] },
      { participant: { name: "B" }, words: [{ text: "three", start_timestamp: { relative: 5 } }] },
    ],
  };
  assert.equal(transcriptText(data), "one two three");
});

test("segments missing a start time keep the API's order", () => {
  const data = [{ transcript: "b", start_time: 9 }, { transcript: "a" }];
  assert.equal(transcriptText(data), "b a");
});

test("an empty list is real silence and gives an empty string", () => {
  assert.equal(transcriptText([]), "");
  assert.equal(transcriptText({ message: [] }), "");
});

test("unknown shapes and error bodies throw instead of looking like silence", () => {
  for (const bad of [{}, null, { results: { utterances: [{ text: "hi" }] } }, [{ foo: 1 }],
    "<html><body><h1>502 Bad Gateway</h1></body></html>", '{"error":"internal"}']) {
    assert.throws(() => transcriptText(bad), UnrecognizedTranscript, JSON.stringify(bad));
  }
  assert.equal(transcriptText("plain words are a transcript"), "plain words are a transcript");
});
