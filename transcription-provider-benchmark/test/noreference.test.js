const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const api = require("../src/api");

test("without a reference transcript the run reports turnaround and word counts, not accuracy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  const texts = { deepgram: "Hello everyone, thanks for joining.", sarvam: "Hello everyone thanks" };
  const jobs = new Map();
  let polls = 0;
  api.getBotStatus = async () => "Done";
  api.transcribe = async (_bot, provider) => {
    const name = Object.keys(provider)[0];
    jobs.set(`t-${name}`, name);
    return { transcript_id: `t-${name}` };
  };
  api.listTranscriptions = async () => {
    polls++;
    return [...jobs].map(([id, name]) => ({ transcript_id: id, provider: name, status: name === "deepgram" || polls > 1 ? "Success" : "Processing" }));
  };
  api.getTranscript = async (id) => [{ start_time: 0, transcript: texts[jobs.get(id)] }];

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-7", providers: ["sarvam", "deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(run.reference, null);
    assert.equal(fs.existsSync(path.join(runDir, "reference.txt")), false);

    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    const by = Object.fromEntries(results.providers.map((r) => [r.provider, r]));
    assert.equal(by.deepgram.wer, null);
    assert.equal(by.deepgram.words, 5);
    assert.equal(by.sarvam.words, 3);
    // Ranked by turnaround when there is no accuracy to rank by.
    assert.deepEqual(results.providers.map((r) => r.provider), ["deepgram", "sarvam"]);

    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /Reference: none, so accuracy is not scored/);
    assert.match(md, /^\| Provider \| Words transcribed \| Turnaround \(finished within\) \| Range over rounds \|/m);
    assert.match(md, /^\| Deepgram \| 5 \| /m);
    assert.doesNotMatch(md, /Errors by provider/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reference added after the run scores it, marked as added later, and can't be added twice", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  let n = 0;
  api.getBotStatus = async () => "Done";
  api.transcribe = async () => ({ transcript_id: `t-${++n}` });
  api.listTranscriptions = async () => Array.from({ length: n }, (_, i) => ({ transcript_id: `t-${i + 1}`, provider: "deepgram", status: "Success" }));
  api.getTranscript = async () => [{ start_time: 0, transcript: "Hello everyone, thanks for joining." }];

  try {
    const { benchmark } = require("../src/benchmark");
    const { addReference } = require("../src/report");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-9", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    fs.writeFileSync("said.txt", "hello everyone thanks for joining us");
    const { results } = addReference(runDir, "said.txt");
    assert.equal(results.reference_words, 6);
    assert.ok(Math.abs(results.providers[0].wer - 1 / 6) < 1e-9); // "us" missed
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.match(run.reference.added_at, /^\d{4}-/);
    assert.equal(fs.readFileSync(path.join(runDir, "reference.txt"), "utf8"), "hello everyone thanks for joining us");
    assert.match(fs.readFileSync(path.join(runDir, "results.md"), "utf8"), /added after the run on/);
    assert.throws(() => addReference(runDir, "said.txt"), /already has a reference/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("noReference ignores the reference saved with the recording; without it, the saved one is used", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.mkdirSync("recordings");
  fs.writeFileSync("saved.txt", "hello everyone thanks for joining");
  fs.writeFileSync("recordings/bot-8.json", JSON.stringify({ bot_id: "bot-8", reference: { path: "saved.txt" } }));
  let n = 0;
  api.getBotStatus = async () => "Done";
  api.transcribe = async () => ({ transcript_id: `t-${++n}` });
  api.listTranscriptions = async () => Array.from({ length: n }, (_, i) => ({ transcript_id: `t-${i + 1}`, provider: "deepgram", status: "Success" }));
  api.getTranscript = async () => [{ start_time: 0, transcript: "Hello everyone, thanks for joining." }];

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let none, saved;
    try {
      none = await benchmark({ botId: "bot-8", noReference: true, providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
      await new Promise((r) => setTimeout(r, 1100)); // run folders are named by the second
      saved = await benchmark({ botId: "bot-8", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(none, "run.json"), "utf8")).reference, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(none, "results.json"), "utf8")).providers[0].wer, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(saved, "run.json"), "utf8")).reference.source, "saved.txt");
    assert.equal(JSON.parse(fs.readFileSync(path.join(saved, "results.json"), "utf8")).providers[0].wer, 0);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
