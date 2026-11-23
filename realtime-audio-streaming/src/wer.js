/**
 * wer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Word error rate for compare.js: how many words a provider got wrong against
 * a reference transcript of what was actually said.
 *
 *   WER = (substitutions + deletions + insertions) / reference words
 *
 * Both texts are normalised the same way first, so formatting isn't counted
 * as a recognition error:
 *   - Unicode NFKC, lower case, curly apostrophes made straight;
 *   - "&" → "and", "12%" → "12 percent", "$5" → "5 dollars";
 *   - hyphens and dashes become spaces; other punctuation is dropped, except
 *     apostrophes inside words and decimal points;
 *   - mr / mrs / dr / st → mister / missus / doctor / saint;
 *   - whole numbers up to 999,999 are spelled out ("25" → twenty five);
 *   - the fillers um, uh, er, erm, hmm, mm and mhm are dropped.
 *
 * It is deliberately small. It does not reconcile British and American
 * spelling or expand contractions, so "colour" vs "color" or "don't" vs
 * "do not" count as errors. Use the same reference for every provider and
 * compare them with each other, not with numbers from other scorers.
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ABBREVIATIONS = { mr: "mister", mrs: "missus", dr: "doctor", st: "saint" };
const FILLERS = new Set(["um", "uh", "er", "erm", "hmm", "mm", "mhm"]);

function underThousand(n) {
  const words = [];
  if (n >= 100) { words.push(ONES[Math.floor(n / 100)], "hundred"); n %= 100; }
  if (n >= 20) { words.push(TENS[Math.floor(n / 10)]); n %= 10; if (n) words.push(ONES[n]); }
  else if (n || !words.length) words.push(ONES[n]);
  return words;
}

/** "25" → "twenty five"; numbers over 999,999 are left as digits. */
export function numberToWords(token) {
  if (!/^\d+$/.test(token)) return token;
  const n = Number(token);
  if (n > 999_999) return token;
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const words = thousands ? [...underThousand(thousands), "thousand", ...(rest ? underThousand(rest) : [])] : underThousand(rest);
  return words.join(" ");
}

/** Normalises a transcript into an array of words. */
export function normalize(text) {
  const spaced = String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d)%/g, "$1 percent")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[-‐-―]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}'.\s]/gu, " ");
  return spaced
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !FILLERS.has(w))
    .flatMap((w) => numberToWords(w).split(" "));
}

/**
 * Aligns hypothesis words to reference words with the fewest edits and counts
 * them. Takes arrays of words (from normalize) or raw strings.
 * @returns {{ wer: number|null, substitutions: number, deletions: number,
 *             insertions: number, referenceWords: number,
 *             alignment: { op: "="|"S"|"D"|"I", ref?: string, hyp?: string }[] }}
 */
export function wer(reference, hypothesis) {
  const ref = Array.isArray(reference) ? reference : normalize(reference);
  const hyp = Array.isArray(hypothesis) ? hypothesis : normalize(hypothesis);
  const R = ref.length, H = hyp.length;
  // d[i][j]: fewest edits turning ref[0..i) into hyp[0..j).
  const d = Array.from({ length: R + 1 }, (_, i) => {
    const row = new Uint32Array(H + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= H; j++) d[0][j] = j;
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const same = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + same, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }
  const alignment = [];
  let i = R, j = H;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      alignment.push(ref[i - 1] === hyp[j - 1] ? { op: "=", ref: ref[i - 1], hyp: hyp[j - 1] } : { op: "S", ref: ref[i - 1], hyp: hyp[j - 1] });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      alignment.push({ op: "D", ref: ref[--i] });
    } else {
      alignment.push({ op: "I", hyp: hyp[--j] });
    }
  }
  alignment.reverse();
  const count = (op) => alignment.filter((a) => a.op === op).length;
  const substitutions = count("S"), deletions = count("D"), insertions = count("I");
  return {
    wer: R ? (substitutions + deletions + insertions) / R : null,
    substitutions,
    deletions,
    insertions,
    referenceWords: R,
    alignment,
  };
}
