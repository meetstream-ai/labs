// Copied from ../transcription-provider-benchmark/src/wer.js so both examples
// score WER identically; keep the two in step if either changes.
import { createRequire } from "module";

/**
 * Word error rate, and the text normalisation applied to both sides before
 * it is computed.
 *
 * Normalisation matters more than anything else in a WER comparison: a
 * provider that writes "Mr." and "25" would otherwise be charged errors
 * against a reference that says "MISTER" and "TWENTY FIVE", which measures
 * formatting, not recognition. The rules below are applied identically to the
 * reference and to every provider's output, and METHODOLOGY.md lists them.
 * scripts/score_jiwer.py re-scores the same files with jiwer and OpenAI's
 * Whisper normaliser for anyone who would rather not trust this one.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

const ORDINAL_WORDS = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth",
};

/** 0 <= n < 1e12, as words: 125 -> "one hundred twenty five". */
function cardinal(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) {
    return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + cardinal(n % 100) : "");
  }
  for (const [size, name] of SCALES) {
    if (n >= size) {
      const rest = n % size;
      return cardinal(Math.floor(n / size)) + " " + name + (rest ? " " + cardinal(rest) : "");
    }
  }
  return String(n);
}

function ordinal(n) {
  const words = cardinal(n).split(" ");
  const last = words.pop();
  let ord;
  if (ORDINAL_WORDS[last]) ord = ORDINAL_WORDS[last];
  else if (last.endsWith("y")) ord = last.slice(0, -1) + "ieth";
  else ord = last + "th";
  return [...words, ord].join(" ");
}

/**
 * A four-digit number that reads as a year is spoken as a year:
 * 1990 -> "nineteen ninety", 1905 -> "nineteen oh five", 2005 -> "two thousand five".
 */
function yearWords(n) {
  if (n >= 2000 && n < 2010) return cardinal(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return cardinal(hi) + " hundred";
  return cardinal(hi) + " " + (lo < 10 ? "oh " + ONES[lo] : cardinal(lo));
}

function numberToWords(token) {
  const ord = token.match(/^(\d+)(st|nd|rd|th)$/);
  if (ord) return ordinal(parseInt(ord[1], 10));

  // 1990s -> "nineteen nineties"
  const plural = token.match(/^(\d+)'?s$/);
  if (plural) {
    const words = numberToWords(plural[1]);
    return words.endsWith("y") ? words.slice(0, -1) + "ies" : words + "s";
  }

  const dec = token.match(/^(\d+)\.(\d+)$/);
  if (dec) {
    return cardinal(parseInt(dec[1], 10)) + " point " + dec[2].split("").map((d) => ONES[+d]).join(" ");
  }

  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    // Numbers this long are almost always read digit by digit (phone
    // numbers, IDs), and are past what cardinal() handles.
    if (token.length > 12) return token.split("").map((d) => ONES[+d]).join(" ");
    if (token.length === 4 && n >= 1100 && n <= 2099) return yearWords(n);
    return cardinal(n);
  }
  return token;
}

// Abbreviations that are spoken as the full word. The reference side
// (LibriSpeech) always spells these out.
const ABBREVIATIONS = {
  mr: "mister",
  mrs: "missus",
  ms: "miss",
  dr: "doctor",
  st: "saint",
  vs: "versus",
};

// Hesitations a reader never says but some providers write down anyway.
const FILLERS = new Set(["um", "uh", "hmm", "mm", "mhm", "mmm", "erm"]);

// British → American spelling ("recognising" → "recognizing"), so a spelling
// convention isn't scored as a recognition error. The list is Whisper's
// (src/data/NOTICE.md), the same one scripts/score_jiwer.py applies.
const SPELLING = createRequire(import.meta.url)("./data/english-spelling.json");

// Contractions with only one reading are expanded, so "don't" and "do not"
// match. "'s" (is / has / possessive) and "'d" (had / would) are ambiguous
// and left as written.
const CONTRACTION_WORDS = { "won't": "will not", "can't": "can not", "shan't": "shall not", cannot: "can not" };
const CONTRACTION_ENDINGS = [["n't", " not"], ["'re", " are"], ["'ve", " have"], ["'ll", " will"], ["'m", " am"]];

function expandContraction(word) {
  if (CONTRACTION_WORDS[word]) return CONTRACTION_WORDS[word];
  for (const [end, full] of CONTRACTION_ENDINGS) {
    if (word.length > end.length && word.endsWith(end)) return word.slice(0, -end.length) + full;
  }
  return word;
}

/**
 * normalize("Mr. Quilter's 2nd-best idea, isn't it, colour-wise?")
 *   -> "mister quilter's second best idea is not it color wise"
 */
function normalize(text) {
  let s = String(text ?? "").normalize("NFKC").toLowerCase();
  s = s.replace(/[‘’ʼ`]/g, "'");
  s = s.replace(/&/g, " and ");
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1"); // 1,000 -> 1000
  // "$4.2 million" is said "four point two million dollars": the unit goes after the scale word.
  s = s.replace(/\$(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion)\b/g, "$1 $2 dollars");
  s = s.replace(/\$(\d+(?:\.\d+)?)/g, "$1 dollars");
  // A day after a month is said as an ordinal: "November 14" -> "November fourteenth".
  s = s.replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/g, "$1 $2th");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent");
  s = s.replace(/(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${h} ${m === "00" ? "" : m}`);
  // Hyphens and dashes join words that are spoken separately.
  s = s.replace(/[-‐-―]/g, " ");
  // Keep letters, digits, apostrophes and the decimal point between digits.
  // Also combining marks (\p{M}): in Tamil, Hindi and other Indic scripts the
  // vowel signs are marks, and dropping them splits words apart and makes
  // different words look the same.
  // NUL stands in for a decimal point while punctuation is removed.
  s = s.replace(/(\d)\.(\d)/g, "$1\u0000$2");
  s = s.replace(/[^\p{L}\p{M}\p{N}'\u0000\s]/gu, " "); // eslint-disable-line no-control-regex
  s = s.replace(/\u0000/g, "."); // eslint-disable-line no-control-regex

  const out = [];
  for (let word of s.split(/\s+/)) {
    word = word.replace(/^'+|'+$/g, "");
    if (!word || FILLERS.has(word)) continue;
    if (ABBREVIATIONS[word]) word = ABBREVIATIONS[word];
    else if (/\d/.test(word)) word = numberToWords(word);
    else word = expandContraction(SPELLING[word] ?? word);
    out.push(word);
  }
  return out.join(" ").split(" ").filter(Boolean).join(" ");
}

/**
 * Levenshtein alignment over words. Returns the edit counts and the aligned
 * pairs, so a report can show which words each provider got wrong instead of
 * only a percentage.
 *
 *   wer("the cat sat", "the bat sat down")
 *   -> { wer: 0.667, substitutions: 1, deletions: 0, insertions: 1, hits: 2, referenceWords: 3, ... }
 */
function wer(reference, hypothesis, { joinCompounds = true } = {}) {
  const ref = reference ? reference.split(" ").filter(Boolean) : [];
  const hyp = hypothesis ? hypothesis.split(" ").filter(Boolean) : [];
  const R = ref.length;
  const H = hyp.length;

  // cost[i][j] = edits to turn ref[0..i) into hyp[0..j)
  const cost = Array.from({ length: R + 1 }, () => new Uint32Array(H + 1));
  for (let i = 0; i <= R; i++) cost[i][0] = i;
  for (let j = 0; j <= H; j++) cost[0][j] = j;
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const sub = cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  const alignment = [];
  let substitutions = 0, deletions = 0, insertions = 0, hits = 0;
  let i = R, j = H;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] === hyp[j - 1]) { hits++; alignment.push({ op: "=", ref: ref[i - 1], hyp: hyp[j - 1] }); }
      else { substitutions++; alignment.push({ op: "S", ref: ref[i - 1], hyp: hyp[j - 1] }); }
      i--; j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      deletions++; alignment.push({ op: "D", ref: ref[i - 1], hyp: null });
      i--;
    } else {
      insertions++; alignment.push({ op: "I", ref: null, hyp: hyp[j - 1] });
      j--;
    }
  }
  alignment.reverse();

  // Compound words written with or without a space ("up guards" / "upguards",
  // "mantel board" / "mantelboard") are the same words heard: a block of
  // errors whose reference and hypothesis words join to the same letters is
  // scored as correct. A different spelling ("michael angelo" / "michelangelo")
  // doesn't join to the same letters and stays an error.
  if (joinCompounds) {
    for (let k = 0; k < alignment.length; k++) {
      if (alignment[k].op === "=") continue;
      for (let len = Math.min(4, alignment.length - k); len >= 2; len--) {
        const block = alignment.slice(k, k + len);
        if (block.some((a) => a.op === "=")) continue;
        const refs = block.map((a) => a.ref).filter(Boolean);
        const hyps = block.map((a) => a.hyp).filter(Boolean);
        if (!refs.length || !hyps.length || refs.length + hyps.length < 3 || refs.join("") !== hyps.join("")) continue;
        for (const a of block) {
          if (a.op === "S") substitutions--;
          else if (a.op === "D") deletions--;
          else insertions--;
        }
        hits += refs.length;
        alignment.splice(k, len, { op: "=", ref: refs.join(" "), hyp: hyps.join(" "), joined: true });
        break;
      }
    }
  }

  const errors = substitutions + deletions + insertions;
  return {
    wer: R === 0 ? (H === 0 ? 0 : 1) : errors / R,
    substitutions,
    deletions,
    insertions,
    hits,
    referenceWords: R,
    hypothesisWords: H,
    alignment,
  };
}

/**
 * Cuts away whatever the provider transcribed before the clip started and
 * after it ended, so talk in the room while the bots wait to be admitted is
 * not scored as the provider's insertion errors.
 *
 * The clip's edges are found from the words themselves: the first and last
 * runs of `anchor` consecutive words the provider got right. Before the first
 * run the provider keeps as many words as the reference has there, so it is
 * still charged for mangling the clip's opening words; anything earlier is
 * outside the clip. The end is handled the same way. The cost of the rule: a
 * genuine insertion right at either edge is not counted.
 *
 * With no anchor at all (a transcript that is mostly wrong) nothing is cut.
 *
 *   clipWindow("a b c d", "hello there a b c d bye")
 *   -> { hypothesis: "a b c d", before: 2, after: 1, anchored: true }
 */
function clipWindow(reference, hypothesis, anchor = 3) {
  const ref = reference ? reference.split(" ").filter(Boolean) : [];
  const hyp = hypothesis ? hypothesis.split(" ").filter(Boolean) : [];

  // Position in ref and hyp at each alignment step.
  const steps = [];
  let ri = 0, hi = 0;
  // Word-by-word alignment (compounds not joined) keeps positions exact.
  for (const a of wer(reference, hypothesis, { joinCompounds: false }).alignment) {
    steps.push({ op: a.op, ri, hi });
    if (a.op !== "I") ri++;
    if (a.op !== "D") hi++;
  }

  let first = -1, last = -1, run = 0;
  for (let k = 0; k < steps.length; k++) {
    run = steps[k].op === "=" ? run + 1 : 0;
    if (run >= anchor) {
      if (first < 0) first = k - anchor + 1;
      last = k;
    }
  }
  if (first < 0) return { hypothesis: hyp.join(" "), before: 0, after: 0, anchored: false };

  const start = Math.max(0, steps[first].hi - steps[first].ri);
  const end = Math.min(hyp.length, steps[last].hi + 1 + (ref.length - 1 - steps[last].ri));
  return { hypothesis: hyp.slice(start, end).join(" "), before: start, after: hyp.length - end, anchored: true };
}

export { normalize, wer, clipWindow, numberToWords };
