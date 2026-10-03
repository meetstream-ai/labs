/**
 * A results folder may come from someone else: re-scoring a published run is
 * how a reader checks it. A crafted run.json must not make `score` read or
 * write files outside that folder.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { score, inRun } = require("../src/report");

function craftedRun(root, { reference, transcript }) {
  const run = path.join(root, "run");
  fs.mkdirSync(path.join(run, "transcripts"), { recursive: true });
  fs.writeFileSync(path.join(run, "run.json"), JSON.stringify({
    run_id: "x", bot: { id: "b" }, environment: { poll_seconds: 1 }, providers: { deepgram: {} },
    reference: reference ? { file: reference, sha256: "0".repeat(64) } : null,
    jobs: [{ provider: "deepgram", status: "Success", round: 1, transcript_file: transcript }],
  }));
  return run;
}

test("run.json paths that climb out of the run folder are refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safety-"));
  try {
    fs.writeFileSync(path.join(root, "secret.txt"), "private words outside the run");
    fs.writeFileSync(path.join(root, "victim.json"), JSON.stringify([{ start_time: 0, transcript: "planted" }]));
    const run = craftedRun(root, { reference: "../secret.txt", transcript: "transcripts/x.json" });
    assert.throws(() => score(run), /outside the run folder/);
    assert.equal(fs.existsSync(path.join(run, "reference.normalized.txt")), false);

    const run2 = craftedRun(fs.mkdtempSync(path.join(root, "b-")), { transcript: "../../victim.json" });
    assert.throws(() => score(run2), /outside the run folder/);
    assert.equal(fs.existsSync(path.join(root, "victim.normalized.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked folder inside the run that points outside it is refused", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safety-"));
  try {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "t.json"), JSON.stringify([{ start_time: 0, transcript: "x" }]));
    const run = craftedRun(root, { transcript: "linked/t.json" });
    try {
      fs.symlinkSync(outside, path.join(run, "linked"), "junction");
    } catch {
      return t.skip("can't create a directory link here");
    }
    assert.throws(() => inRun(run, "linked/t.json"), /symlink/);
    assert.throws(() => score(run), /outside the run folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary paths inside the run folder are fine", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "safety-"));
  try {
    const run = craftedRun(root, { transcript: "transcripts/deepgram.r1.json" });
    assert.equal(inRun(run, "transcripts/deepgram.r1.json"), path.join(fs.realpathSync(run), "transcripts", "deepgram.r1.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
