/**
 * Builds the benchmark's reference clip: sample/clip.wav + sample/reference.txt.
 *
 * Source: LibriSpeech (CC BY 4.0), via a 73-utterance slice of dev-clean that
 * Hugging Face publishes as a single 9 MB parquet file. The file is pinned by
 * commit and checked by sha256, and utterances are taken in dataset order
 * until the clip is long enough, so every run of this script produces the
 * same clip and nobody picked the sentences.
 *
 *   node scripts/fetch-sample.js [--seconds 180]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseArgs } = require("util");
const { decodeToPcm, pcmToWav, sha256File } = require("../src/audio");

const DATASET = "hf-internal-testing/librispeech_asr_dummy";
const REVISION = "5be91486e11a2d616f4ec5db8d3fd248585ac07a";
const FILE = "clean/validation-00000-of-00001.parquet";
const FILE_SHA256 = "4e69a06fa5edc90921e5e7e39a7084881f8b3ed9c805c574f4f39c6fde27c603";
const URL = `https://huggingface.co/datasets/${DATASET}/resolve/${REVISION}/${FILE}`;

const SAMPLE_RATE = 16_000;
const GAP_SECONDS = 0.75; // silence between utterances, so they don't run together in the call

const OUT_DIR = path.join(process.env.BENCH_DATA_DIR || path.join(__dirname, ".."), "sample");
const CACHE = path.join(OUT_DIR, ".cache", "librispeech_asr_dummy.parquet");

async function download() {
  if (fs.existsSync(CACHE) && sha256File(CACHE) === FILE_SHA256) return;
  console.log(`  Downloading ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha !== FILE_SHA256) {
    throw new Error(`sha256 mismatch: expected ${FILE_SHA256}, got ${sha}. Refusing to build a clip from it.`);
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, bytes);
}

async function main() {
  const { values } = parseArgs({ options: { seconds: { type: "string", default: "180" } } });
  const target = parseFloat(values.seconds);

  await download();

  // hyparquet is ESM-only.
  const { asyncBufferFromFile, parquetReadObjects } = await import("hyparquet");
  const rows = await parquetReadObjects({
    file: await asyncBufferFromFile(CACHE),
    columns: ["id", "text", "audio"],
    utf8: false, // audio.bytes is binary FLAC; decoding it as UTF-8 corrupts it
  });

  const gap = Buffer.alloc(Math.round(GAP_SECONDS * SAMPLE_RATE) * 2);
  const parts = [];
  const utterances = [];
  let seconds = 0;
  for (const row of rows) {
    if (seconds >= target) break;
    const pcm = await decodeToPcm(row.audio.bytes, SAMPLE_RATE);
    const duration = pcm.length / 2 / SAMPLE_RATE;
    if (parts.length) parts.push(gap);
    parts.push(pcm);
    utterances.push({ id: String(row.id), start: +seconds.toFixed(3), duration: +duration.toFixed(3), text: String(row.text) });
    seconds += (parts.length > 1 ? GAP_SECONDS : 0) + duration;
  }

  const clipPath = path.join(OUT_DIR, "clip.wav");
  fs.writeFileSync(clipPath, pcmToWav(Buffer.concat(parts), SAMPLE_RATE));
  fs.writeFileSync(path.join(OUT_DIR, "reference.txt"), utterances.map((u) => u.text).join("\n") + "\n");

  const manifest = {
    source: {
      corpus: "LibriSpeech dev-clean (Panayotov et al., 2015), https://www.openslr.org/12",
      license: "CC BY 4.0",
      dataset: DATASET,
      revision: REVISION,
      file: FILE,
      file_sha256: FILE_SHA256,
    },
    selection: `First ${utterances.length} utterances in file order, stopping once the clip reached ${target}s.`,
    sample_rate: SAMPLE_RATE,
    gap_seconds: GAP_SECONDS,
    duration_seconds: +seconds.toFixed(3),
    clip_sha256: sha256File(clipPath),
    utterances,
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`  ${utterances.length} utterances, ${seconds.toFixed(1)}s`);
  console.log(`  sample/clip.wav       sha256 ${manifest.clip_sha256}`);
  console.log(`  sample/reference.txt  ${utterances.reduce((n, u) => n + u.text.split(" ").length, 0)} words`);
}

main().catch((err) => {
  console.error(`  ${err.message}`);
  process.exit(1);
});
