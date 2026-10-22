// Run `npm run fetch-sample` first (it downloads and checks the pinned file),
// then `node reports/2026-10-02/inputs/build-clip-b.js` to rebuild clip-b.wav.
// Clip B: the utterances right after the published sample's 18, from the same
// pinned LibriSpeech file, so it has different speakers and an exact transcript.
const fs = require("fs"), path = require("path");
const REPO = path.join(__dirname, "..", "..", "..");
const { decodeToPcm, pcmToWav, sha256File } = require(`${REPO}/src/audio`);
(async () => {
  const { pathToFileURL } = require("url"); const { asyncBufferFromFile, parquetReadObjects } = await import(pathToFileURL(require.resolve("hyparquet", { paths: [REPO] })).href);
  const rows = await parquetReadObjects({ file: await asyncBufferFromFile(path.join(REPO, "sample", ".cache", "librispeech_asr_dummy.parquet")), columns: ["id", "text", "audio"], utf8: false });
  const RATE = 16000, GAP = 0.75, gap = Buffer.alloc(Math.round(GAP * RATE) * 2);
  const parts = [], utts = []; let seconds = 0;
  for (const row of rows.slice(18)) {
    if (seconds >= 120) break;
    const pcm = await decodeToPcm(row.audio.bytes, RATE);
    if (parts.length) parts.push(gap);
    parts.push(pcm);
    utts.push({ id: String(row.id), text: String(row.text) });
    seconds += (parts.length > 1 ? GAP : 0) + pcm.length / 2 / RATE;
  }
  const out = __dirname;
  fs.writeFileSync(`${out}/clip-b.wav`, pcmToWav(Buffer.concat(parts), RATE));
  fs.writeFileSync(`${out}/clip-b-reference.txt`, utts.map((u) => u.text).join("\n") + "\n");
  fs.writeFileSync(`${out}/clip-b-manifest.json`, JSON.stringify({ selection: "utterances 19 onward of the pinned LibriSpeech file, until 120 s", utterances: utts, seconds: +seconds.toFixed(1), sha256: sha256File(`${out}/clip-b.wav`) }, null, 2));
  const speakers = [...new Set(utts.map((u) => u.id.split("-")[0]))];
  console.log(`${utts.length} utterances, ${seconds.toFixed(1)} s, ${utts.reduce((n, u) => n + u.text.split(" ").length, 0)} words, speakers ${speakers.join(",")}`);
})();
