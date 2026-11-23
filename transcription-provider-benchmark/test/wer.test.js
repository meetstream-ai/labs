const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, wer, numberToWords } = require("../src/wer");

test("formatting differences that are not recognition errors normalise away", () => {
  const reference = normalize("MISTER QUILTER'S MANNER IS TWENTY FIVE TIMES LESS INTERESTING");
  const hypothesis = normalize("Mr. Quilter’s manner is 25 times less—interesting!");
  assert.equal(hypothesis, reference);
  assert.equal(wer(reference, hypothesis).wer, 0);
});

test("normalize handles the forms providers actually emit", () => {
  assert.equal(normalize("Dr. Smith & co., 2nd floor"), "doctor smith and co second floor");
  assert.equal(normalize("It cost $3.50, about 12% more"), "it cost three point five zero dollars about twelve percent more");
  assert.equal(normalize("Up guards and at 'em"), "up guards and at em");
  assert.equal(normalize("Um, so, uh, yes"), "so yes");
  assert.equal(normalize("In the 1990s, 1,000 people"), "in the nineteen nineties one thousand people");
  assert.equal(normalize(""), "");
});

test("wer matches hand-worked answers", () => {
  const W = (r, h) => wer(normalize(r), normalize(h)).wer;
  assert.equal(W("the cat sat", "The cat sat."), 0);             // perfect, punctuation and case ignored
  assert.equal(W("the cat sat", "the bat sat"), 1 / 3);          // 1 substitution
  assert.equal(W("the cat sat", "the sat"), 1 / 3);              // 1 deletion
  assert.equal(W("the cat sat", "the big cat sat"), 1 / 3);      // 1 insertion
  assert.equal(W("the cat sat", "dogs run fast"), 1);            // all wrong
  assert.equal(W("the cat sat", ""), 1);                         // empty hypothesis: all deleted
  assert.equal(W("a  b\n\tc", " a b c "), 0);                     // whitespace
  assert.equal(W("Hello, WORLD! It's me.", "hello world it's me"), 0);
});

test("spelling conventions, contractions and compound spacing are formatting, not errors", () => {
  const W = (r, h) => wer(normalize(r), normalize(h));
  assert.equal(W("colour recognising behaviour", "color recognizing behavior").wer, 0);  // British / American
  assert.equal(W("do not go we are here", "don't go we're here").wer, 0);               // contractions
  assert.equal(W("I will not", "I won't").wer, 0);
  assert.equal(W("up guards and at em", "upguards and at em").wer, 0);                // compound written as one word
  assert.equal(W("the mantelboard", "the mantel board").wer, 0);                       // ... or as two
  // Still errors: a different word, a different spelling, and an ambiguous 's.
  assert.equal(W("michael angelo", "michelangelo").wer, 1);
  assert.equal(W("up guards", "upgard's").substitutions + W("up guards", "upgard's").deletions, 2);
  assert.equal(W("it is", "it's").wer > 0, true);
});

test("money with a scale word, and dates, are read the way people say them", () => {
  const W = (r, h) => wer(normalize(r), normalize(h)).wer;
  assert.equal(W("four point two million dollars", "$4.2 million"), 0);
  assert.equal(W("about three billion dollars", "about $3 billion"), 0);
  assert.equal(W("ships on november fourteenth", "ships on November 14"), 0);
  assert.equal(W("by may first", "by May 1st"), 0);
  assert.equal(normalize("$5"), "five dollars");                         // unchanged
});

test("a joined compound counts once as correct and keeps the reference word count", () => {
  const r = wer(normalize("up guards and at em"), normalize("upguards and at em"));
  assert.equal(r.referenceWords, 5);
  assert.equal(r.hits, 5);
  assert.deepEqual(r.alignment[0], { op: "=", ref: "up guards", hyp: "upguards", joined: true });
});

test("Indic scripts keep their vowel signs, so words stay whole and different words stay different", () => {
  assert.equal(normalize("வணக்கம் எல்லோரும்!"), "வணக்கம் எல்லோரும்");
  assert.equal(normalize("नमस्ते, दोस्तों।"), "नमस्ते दोस्तों");
  const r = wer(normalize("வணக்கம் எல்லோரும்"), normalize("வணக்கம் எல்லாரும்"));
  assert.equal(r.referenceWords, 2);
  assert.equal(r.substitutions, 1);
});

test("numbers read the way people say them", () => {
  assert.equal(numberToWords("0"), "zero");
  assert.equal(numberToWords("117"), "one hundred seventeen");
  assert.equal(numberToWords("1905"), "nineteen oh five");
  assert.equal(numberToWords("2005"), "two thousand five");
  assert.equal(numberToWords("2024"), "twenty twenty four");
  assert.equal(numberToWords("1900"), "nineteen hundred");
  assert.equal(numberToWords("5000"), "five thousand");
  assert.equal(numberToWords("1234567"), "one million two hundred thirty four thousand five hundred sixty seven");
  assert.equal(numberToWords("21st"), "twenty first");
  assert.equal(numberToWords("40th"), "fortieth");
});

test("wer counts substitutions, deletions and insertions", () => {
  // Chosen so there is only one minimal alignment.
  const r = wer("the cat sat on the mat", "well the bat sat on mat");
  assert.equal(r.substitutions, 1);
  assert.equal(r.deletions, 1);
  assert.equal(r.insertions, 1);
  assert.equal(r.hits, 4);
  assert.equal(r.referenceWords, 6);
  assert.equal(r.wer, 3 / 6);
  assert.deepEqual(
    r.alignment.filter((a) => a.op !== "="),
    [
      { op: "I", ref: null, hyp: "well" },
      { op: "S", ref: "cat", hyp: "bat" },
      { op: "D", ref: "the", hyp: null },
    ]
  );
});

test("wer edge cases", () => {
  assert.equal(wer("a b c", "").wer, 1);
  assert.equal(wer("a b c", "").deletions, 3);
  assert.equal(wer("", "").wer, 0);
  assert.equal(wer("", "x").wer, 1);
  // WER is not capped at 100%: inserting more words than the reference has is possible.
  assert.equal(wer("a", "x y z").wer, 3);
});

const { clipWindow } = require("../src/wer");

test("clipWindow cuts talk before and after the clip", () => {
  const ref = "mister quilter is the apostle of the middle classes";
  const w = clipWindow(ref, "hi everyone let's start mister quilter is the apostle of the middle classes okay bye");
  assert.deepEqual(w, { hypothesis: ref, before: 4, after: 2, anchored: true });
  assert.equal(wer(ref, w.hypothesis).wer, 0);
});

test("clipWindow still charges errors on the clip's own first and last words", () => {
  const ref = "mister quilter is the apostle of the middle classes";
  // First two words and the last word misheard, with chatter around it. Two
  // reference words precede the first correct run, so two hypothesis words
  // are kept there; one follows the last run, so one is kept after it.
  const w = clipWindow(ref, "hello there my ster quilted is the apostle of the middle bye now");
  assert.equal(w.hypothesis, "ster quilted is the apostle of the middle bye");
  assert.equal(w.before, 3);
  assert.equal(w.after, 1);
  const r = wer(ref, w.hypothesis);
  assert.equal(r.substitutions, 3); // mister→ster, quilter→quilted, classes→bye
  assert.equal(r.deletions + r.insertions, 0);
});

test("clipWindow leaves everything when no run of correct words anchors the clip", () => {
  const w = clipWindow("a b c d e", "x a y b z");
  assert.deepEqual(w, { hypothesis: "x a y b z", before: 0, after: 0, anchored: false });
});

test("talk in the middle of the clip still counts", () => {
  const ref = "one two three four five six seven eight";
  const w = clipWindow(ref, "one two three hey there four five six seven eight");
  assert.equal(w.before + w.after, 0);
  assert.equal(wer(ref, w.hypothesis).insertions, 2);
});
