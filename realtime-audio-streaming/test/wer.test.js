import test from "node:test";
import assert from "node:assert/strict";
import { normalize, numberToWords, wer } from "../src/wer.js";

test("normalize: formatting is not counted as a recognition error", () => {
  assert.deepEqual(normalize("Mr. Quilter’s well-known  colour!"), ["mister", "quilter's", "well", "known", "colour"]);
  assert.deepEqual(normalize("Q&A at 3.5% — $5, um, 1,200 people"),
    ["q", "and", "a", "at", "3.5", "percent", "5", "dollars", "one", "thousand", "two", "hundred", "people"].map((w) => (w === "5" ? "five" : w)));
  assert.deepEqual(normalize(""), []);
});

test("numberToWords spells whole numbers up to 999,999", () => {
  assert.equal(numberToWords("0"), "zero");
  assert.equal(numberToWords("25"), "twenty five");
  assert.equal(numberToWords("110"), "one hundred ten");
  assert.equal(numberToWords("40000"), "forty thousand");
  assert.equal(numberToWords("1000000"), "1000000");
  assert.equal(numberToWords("abc"), "abc");
});

test("wer counts substitutions, deletions and insertions on hand-worked cases", () => {
  const ref = "the cat sat on the mat";
  assert.equal(wer(ref, "the cat sat on the mat").wer, 0);

  const sub = wer(ref, "the cat sat on a mat");
  assert.deepEqual([sub.substitutions, sub.deletions, sub.insertions], [1, 0, 0]);
  assert.equal(sub.wer, 1 / 6);

  const del = wer(ref, "the cat on the mat");
  assert.deepEqual([del.substitutions, del.deletions, del.insertions], [0, 1, 0]);

  const ins = wer(ref, "the cat sat down on the mat");
  assert.deepEqual([ins.substitutions, ins.deletions, ins.insertions], [0, 0, 1]);
  assert.deepEqual(ins.alignment.find((a) => a.op === "I"), { op: "I", hyp: "down" });

  // Can exceed 100%: every reference word missed plus extra words.
  assert.equal(wer("hello", "goodbye cruel world").wer, 3);
  assert.equal(wer("", "anything").wer, null);
});
