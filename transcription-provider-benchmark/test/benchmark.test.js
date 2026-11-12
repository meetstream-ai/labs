/**
 * Runs the whole benchmark step against a stubbed MeetStream API, so the
 * orchestration (submit together, poll, fetch, score, write files) is checked
 * without a key, a meeting or any network.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const api = require("../src/api");

const REFERENCE = "MISTER QUILTER IS THE APOSTLE OF THE MIDDLE CLASSES";
const OUTPUTS = {
  meetstream: "Mr. Quilter is the apostle of the middle classes.",
  deepgram: "Mister Quilter is the apostle of the middle class.",
  assemblyai: "Mr. Quilter is an apostle of the middle classes and",
};

test("benchmark submits every provider, times them, scores them and reports the ones that could not run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");

  // Each provider finishes on a different poll; sarvam is not configured on
  // the account and jigsawstack never finishes.
  const jobs = new Map();
  let polls = 0;
  const finishOnPoll = { meetstream: 1, deepgram: 2, assemblyai: 3, jigsawstack: Infinity };
  api.getBotStatus = async () => "Done";
  api.transcribe = async (botId, provider) => {
    const name = Object.keys(provider)[0];
    if (name === "sarvam") {
      const err = new Error("Request failed");
      err.response = { status: 400, data: { detail: "Sarvam is not configured for this account" } };
      throw err;
    }
    const id = `t-${name}-${jobs.size}`;
    jobs.set(id, name);
    return { bot_id: botId, transcript_id: id, provider: name };
  };
  api.listTranscriptions = async () => {
    polls++;
    return [...jobs].map(([id, name]) => ({
      transcript_id: id,
      provider: name,
      status: polls % 3 >= finishOnPoll[name] % 3 && polls >= finishOnPoll[name] ? "Success" : "Processing",
    }));
  };
  api.getTranscript = async (id) => [{ speaker: "A", start_time: 0, transcript: OUTPUTS[jobs.get(id)] }];

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({
        botId: "bot-1",
        referencePath: "reference.txt",
        providers: ["meetstream", "deepgram", "assemblyai", "sarvam", "jigsawstack"],
        rounds: 2,
        pollSeconds: 0.01,
        timeoutMinutes: 0.005,
      });
    } finally {
      console.log = log;
    }

    const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    const by = Object.fromEntries(results.providers.map((r) => [r.provider, r]));

    assert.equal(by.meetstream.wer, 0);
    assert.equal(by.deepgram.wer, 1 / 9);
    // the->an; the trailing "and" comes after the clip's last word, so it is
    // cut as outside the clip rather than counted.
    assert.equal(by.assemblyai.wer, 1 / 9);
    assert.equal(by.assemblyai.outside_clip_words, 1);
    assert.equal(by.assemblyai.wer_untrimmed, 2 / 9);
    // MeetStream runs each provider once per recording, so a provider that
    // succeeded is not resubmitted in round 2 (it would only be refused).
    assert.equal(by.meetstream.rounds, 1);
    assert.equal(by.deepgram.rounds, 1);
    assert.equal(by.deepgram.succeeded, 1);
    assert.ok(by.meetstream.turnaround_median_s <= by.deepgram.turnaround_median_s);

    assert.equal(by.sarvam.ran, false);
    assert.match(by.sarvam.reason, /HTTP 400.*not configured/);
    assert.equal(by.jigsawstack.ran, false);
    assert.match(by.jigsawstack.reason, /no result after/);

    // Ranked by WER, providers that did not run last.
    assert.deepEqual(results.providers.map((r) => r.provider).slice(0, 3), ["meetstream", "deepgram", "assemblyai"]);

    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /\| Mia Transcribe \| 0\.0% \|/);
    assert.match(md, /\| Sarvam \| not run \|/);
    assert.match(md, /`S the→an`/);

    // Everything needed to re-score offline is inside the run directory.
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.deepEqual(run.providers.deepgram, { deepgram: { model: "nova-3", language: "en" } });
    for (const job of run.jobs.filter((j) => j.status === "Success")) {
      assert.ok(fs.existsSync(path.join(runDir, job.transcript_file)));
    }

    // And re-scoring gives the same numbers.
    const { score } = require("../src/report");
    fs.rmSync(path.join(runDir, "results.json"));
    assert.deepEqual(score(runDir).results.providers.map((r) => r.wer), results.providers.map((r) => r.wer));
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bot that already spent its one meetstream run is scored from that run's transcript", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");

  api.getBotStatus = async () => "Done";
  api.transcribe = async () => {
    const err = new Error("Request failed");
    err.response = { status: 409, data: { error: "MeetStream transcription has already been used for this bot. This provider can only be used once per bot." } };
    throw err;
  };
  api.listTranscriptions = async () => [
    { transcript_id: "earlier", provider: "meetstream", status: "Success", created_at: "2026-09-28T11:12:33Z", config: { language: "auto" } },
    { transcript_id: null, provider: "meeting_captions", status: "Success" },
  ];
  api.getTranscript = async () => ({ message: [{ participant: { name: "A" }, words: [{ text: OUTPUTS.meetstream }] }] });

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-2", referencePath: "reference.txt", providers: ["meetstream"], rounds: 3, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const { providers: [row] } = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    assert.equal(row.ran, true);
    assert.equal(row.wer, 0);
    assert.equal(row.rounds, 1);
    assert.equal(row.turnaround_median_s, null);
    assert.match(row.notes[0], /already run on this bot.*turnaround not measured/);
    assert.match(fs.readFileSync(path.join(runDir, "results.md"), "utf8"), /\| Mia Transcribe \| 0\.0% \|.*\| – \|/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed or rate-limited provider is marked not run with its reason; the others are still scored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  api.transcribe = async (_bot, provider) => {
    const name = Object.keys(provider)[0];
    if (name === "assemblyai") {
      const err = new Error("Request failed");
      err.response = { status: 429, data: { error: "Too many requests" } };
      throw err;
    }
    return { transcript_id: `t-${name}` };
  };
  api.listTranscriptions = async () => [
    { transcript_id: "t-deepgram", provider: "deepgram", status: "Success" },
    { transcript_id: "t-sarvam", provider: "sarvam", status: "Failed", error: "provider returned 500" },
  ];
  api.getTranscript = async (_id, opts) => (opts?.raw ? {} : [{ start_time: 0, transcript: OUTPUTS.deepgram }]);

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-11", referencePath: "reference.txt", providers: ["deepgram", "sarvam", "assemblyai"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005, retryDelayMs: 10 });
    } finally {
      console.log = log;
    }
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).providers.map((r) => [r.provider, r]));
    assert.equal(by.deepgram.ran, true);
    assert.ok(by.deepgram.wer > 0 && by.deepgram.wer < 0.2);
    assert.deepEqual([by.sarvam.ran, by.sarvam.wer, by.sarvam.reason], [false, undefined, "provider returned 500"]);
    assert.equal(by.assemblyai.ran, false);
    assert.match(by.assemblyai.reason, /^HTTP 429/);
    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /^\| Sarvam \| not run \|/m);
    assert.match(md, /^\| AssemblyAI \| not run \|/m);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turnaround is reported as the window it's known to, and a separately submitted provider isn't comparable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  // The request itself takes 30 ms; both providers are done by the first poll.
  api.getBotStatus = async () => "Done";
  api.transcribe = async (_bot, provider) => {
    await new Promise((r) => setTimeout(r, 30));
    return { transcript_id: `t-${Object.keys(provider)[0]}` };
  };
  api.listTranscriptions = async () => ["deepgram", "assemblyai"].map((p) => ({ transcript_id: `t-${p}`, provider: p, status: "Success" }));
  api.getTranscript = async (_id, opts) => (opts?.raw ? {} : [{ start_time: 0, transcript: OUTPUTS.deepgram }]);

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-13", referencePath: "reference.txt", providers: ["deepgram", "assemblyai"], rounds: 1, pollSeconds: 0.2, timeoutMinutes: 0.05 });
      // Then assemblyai again on its own, as if re-run later with --append.
      await benchmark({ botId: "bot-13", referencePath: "reference.txt", providers: ["assemblyai"], rounds: 1, pollSeconds: 0.2, timeoutMinutes: 0.05, appendTo: runDir });
    } finally {
      console.log = log;
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    for (const j of run.jobs) assert.ok(j.request_s >= 0.02, "the request's own time is recorded");
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).providers.map((r) => [r.provider, r]));
    // Known only to a window: after the requests returned, by the first poll.
    assert.ok(by.deepgram.turnaround_lower_s >= 0.02 && by.deepgram.turnaround_lower_s < by.deepgram.turnaround_median_s);
    assert.ok(by.deepgram.turnaround_median_s >= 0.2);
    assert.equal(by.deepgram.turnaround_comparable, true);
    assert.equal(by.assemblyai.turnaround_comparable, false);
    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /\| AssemblyAI \|.*\d–\d+\.\ds ‡ \|/);
    assert.match(md, /not the provider's own API latency/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs `fn` in a fresh temp folder with console.log silenced.
async function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  const log = console.log;
  process.chdir(dir);
  console.log = () => {};
  try { return await fn(dir); } finally { console.log = log; process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
}
const oneProvider = (text = OUTPUTS.deepgram, raw = {}) => {
  api.getBotStatus = async () => "Done";
  api.transcribe = async (bot) => ({ transcript_id: `${bot}-t` });
  api.listTranscriptions = async (bot) => [{ transcript_id: `${bot}-t`, provider: "deepgram", status: "Success" }];
  api.getTranscript = async (_id, opts) => (opts?.raw ? raw : [{ start_time: 0, transcript: text }]);
};

test("a stopped bot with no captured audio fails at once, with MeetStream's reason", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", REFERENCE + "\n");
    oneProvider();
    api.getBotStatus = async () => "Stopped";
    api.getRecordingState = async () => ({ ready: false, problem: "No usable mixed audio was captured" });
    let submitted = false;
    api.transcribe = async () => { submitted = true; return { transcript_id: "t" }; };
    const { benchmark } = require("../src/benchmark");
    const started = Date.now();
    await assert.rejects(benchmark({ botId: "bot-20", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 }),
      /no recording to transcribe: No usable mixed audio was captured/);
    assert.ok(Date.now() - started < 5000, "doesn't wait for the 30-minute deadline");
    assert.equal(submitted, false);
  });
});

test("a Zoom bot that stays Stopped after processing is treated as ready", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", REFERENCE + "\n");
    oneProvider();
    api.getBotStatus = async () => "Stopped";
    api.getRecordingState = async () => ({ ready: true, problem: null });
    const { benchmark } = require("../src/benchmark");
    const dir = await benchmark({ botId: "bot-21", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    assert.equal(run.bot.status_when_benchmarked, "Done");
    assert.equal(run.jobs[0].status, "Success");
  });
});

test("a reference with no words is refused before anything is submitted", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", "Um.\n");
    let submitted = false;
    oneProvider();
    api.transcribe = async () => { submitted = true; return { transcript_id: "t" }; };
    const { benchmark } = require("../src/benchmark");
    await assert.rejects(benchmark({ botId: "bot-16", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 }), /no words after normalisation/);
    assert.equal(submitted, false);
  });
});

test("two runs started in the same second get their own folders", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", REFERENCE + "\n");
    oneProvider();
    const { benchmark } = require("../src/benchmark");
    const opts = { referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 };
    const [a, b] = await Promise.all([benchmark({ ...opts, botId: "bot-17a" }), benchmark({ ...opts, botId: "bot-17b" })]);
    assert.notEqual(a, b);
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, "run.json"), "utf8")).bot.id, "bot-17a");
    assert.equal(JSON.parse(fs.readFileSync(path.join(b, "run.json"), "utf8")).bot.id, "bot-17b");
  });
});

test("a submit that hits a rate limit is retried once and marked as timed separately", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", REFERENCE + "\n");
    oneProvider();
    let calls = 0;
    api.transcribe = async (bot) => {
      if (++calls === 1) { const e = new Error("x"); e.response = { status: 429, data: { error: "Too many requests" } }; throw e; }
      return { transcript_id: `${bot}-t` };
    };
    const { benchmark } = require("../src/benchmark");
    const dir = await benchmark({ botId: "bot-18", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005, retryDelayMs: 10 });
    const job = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).jobs[0];
    assert.equal(calls, 2);
    assert.equal(job.status, "Success");
    assert.match(job.submit_retried.first_error, /^HTTP 429/);
    const [row] = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8")).providers;
    assert.equal(row.turnaround_comparable, false);
  });
});

test("the link to the recording is removed from saved raw responses", async () => {
  await inTemp(async () => {
    fs.writeFileSync("reference.txt", REFERENCE + "\n");
    oneProvider(OUTPUTS.deepgram, { audio_url: "https://cdn.example/upload/abc", audio_duration: 12 });
    const { benchmark } = require("../src/benchmark");
    const dir = await benchmark({ botId: "bot-19", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    const job = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).jobs[0];
    const raw = JSON.parse(fs.readFileSync(path.join(dir, job.raw_file), "utf8"));
    assert.doesNotMatch(raw.audio_url, /https?:/);
    assert.equal(raw.audio_duration, 12);
  });
});

test("a run records the harness version and commit, and the model each provider reports", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  api.transcribe = async () => ({ transcript_id: "t-deepgram" });
  api.listTranscriptions = async () => [{ transcript_id: "t-deepgram", provider: "deepgram", status: "Success" }];
  api.getTranscript = async (_id, opts) => (opts?.raw
    ? { metadata: { duration: 12, model_info: { x: { name: "general-nova-3", version: "2025-07-31.0", arch: "nova-3" } } }, results: {} }
    : [{ start_time: 0, transcript: OUTPUTS.deepgram }]);

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-15", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(run.harness_version.version, require("../package.json").version);
    assert.ok(run.harness_version.commit === null || /^[0-9a-f]{40}$/.test(run.harness_version.commit));
    const [row] = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).providers;
    assert.equal(row.model_reported, "general-nova-3 2025-07-31.0");
    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /^- Harness: version \d/m);
    assert.match(md, /Deepgram general-nova-3 2025-07-31\.0/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two providers with the very same transcript are flagged as one engine", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  api.transcribe = async (_bot, provider) => ({ transcript_id: `t-${Object.keys(provider)[0]}` });
  api.listTranscriptions = async () => ["meetstream", "jigsawstack", "deepgram"].map((p) => ({ transcript_id: `t-${p}`, provider: p, status: "Success" }));
  api.getTranscript = async (id, opts) => (opts?.raw ? {} : [{ start_time: 0, transcript: id === "t-deepgram" ? OUTPUTS.deepgram : OUTPUTS.meetstream }]);

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-14", referencePath: "reference.txt", providers: ["meetstream", "jigsawstack", "deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).providers.map((r) => [r.provider, r]));
    assert.deepEqual(by.meetstream.same_output_as, ["jigsawstack"]);
    assert.deepEqual(by.jigsawstack.same_output_as, ["meetstream"]);
    assert.equal(by.deepgram.same_output_as, undefined);
    assert.match(fs.readFileSync(path.join(runDir, "results.md"), "utf8"), /Mia Transcribe\*\*: returned exactly the same transcript as JigsawStack/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a transcript in a shape we can't read is a failure, not a provider that heard nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  api.transcribe = async (_bot, provider) => ({ transcript_id: `t-${Object.keys(provider)[0]}` });
  api.listTranscriptions = async () => ["deepgram", "sarvam"].map((p) => ({ transcript_id: `t-${p}`, provider: p, status: "Success" }));
  api.getTranscript = async (id, opts) => (opts?.raw ? {} : id === "t-deepgram" ? [{ start_time: 0, transcript: OUTPUTS.deepgram }] : { results: { utterances: [{ text: "?" }] } });

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-12", referencePath: "reference.txt", providers: ["deepgram", "sarvam"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const by = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8")).providers.map((r) => [r.provider, r]));
    assert.equal(by.deepgram.ran, true);
    assert.equal(by.sarvam.ran, false);
    assert.match(by.sarvam.reason, /unrecognised transcript shape/);
    const job = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8")).jobs.find((j) => j.provider === "sarvam");
    assert.equal(job.status, "ParseFailed");
    assert.ok(fs.existsSync(path.join(runDir, job.transcript_file)), "the unreadable response is kept for inspection");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an earlier transcript made with a different model isn't scored under this provider's name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  api.transcribe = async () => ({ transcript_id: "again" });
  api.listTranscriptions = async () => [
    { transcript_id: "again", provider: "deepgram", status: "Failed", error: "Equivalent retranscription work was already claimed" },
    { transcript_id: "old", provider: "deepgram", status: "Success", config: { model: "nova-2", language: "en" } },
  ];
  api.getTranscript = async () => [{ start_time: 0, transcript: OUTPUTS.deepgram }];

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-10", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    const job = run.jobs.find((j) => j.provider === "deepgram");
    assert.notEqual(job.status, "Success");
    assert.equal(job.reused, undefined);
    assert.match(job.note, /different settings.*nova-2/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider the transcribe endpoint refuses is scored from its live run, with the post-call timing marked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  fs.mkdirSync("recordings");
  fs.writeFileSync("recordings/bot-3.json", JSON.stringify({
    bot_id: "bot-3", meeting_platform: "meet.google.com", live_provider: "assemblyai",
    live_transcript: { provider: "assemblyai", transcript_id: "live-aai", status: "Success", turnaround_after_leaving_s: 42.5 },
    clip: { path: "sample/clip.wav", sha256: "0".repeat(64), seconds: 191.4 },
    reference: { path: "reference.txt", sha256: "0".repeat(64) },
  }));

  api.getBotStatus = async () => "Done";
  api.transcribe = async () => {
    const err = new Error("Request failed");
    err.response = { status: 400, data: { error: "No API key configured for provider 'assemblyai'." } };
    throw err;
  };
  api.listTranscriptions = async () => [{ transcript_id: "live-aai", provider: "assemblyai", status: "Success", created_at: "2026-09-28T16:53:02Z" }];
  api.getTranscript = async () => [{ start_time: 0, transcript: OUTPUTS.assemblyai }];

  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-3", providers: ["assemblyai"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const { providers: [row] } = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    assert.equal(row.ran, true);
    assert.equal(row.turnaround_median_s, null);
    assert.equal(row.post_call_turnaround_s, 42.5);
    assert.match(row.notes[0], /transcribe endpoint refused it.*finished 42\.5s after the bots left/);
    const md = fs.readFileSync(path.join(runDir, "results.md"), "utf8");
    assert.match(md, /\| AssemblyAI \|.*\| 42\.5s after call † \|/);
    assert.match(md, /^† Ran live on the recording bot/m);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that fails inside MeetStream before reaching the provider is resubmitted once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  const jobs = new Map();
  api.getBotStatus = async () => "Done";
  api.transcribe = async () => {
    const id = `t-${jobs.size}`;
    jobs.set(id, jobs.size === 0 ? "Failed" : "Success");
    return { transcript_id: id };
  };
  api.listTranscriptions = async () => [...jobs].map(([id, status]) => ({
    transcript_id: id, provider: "deepgram", status,
    ...(status === "Failed" ? { error: "Retranscription failed before provider submission" } : {}),
  }));
  api.getTranscript = async () => [{ start_time: 0, transcript: OUTPUTS.deepgram }];
  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-4", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
    } finally {
      console.log = log;
    }
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(run.jobs.length, 2);
    assert.equal(run.jobs[0].superseded, true);
    assert.equal(run.jobs[1].attempt, 2);
    const { providers: [row] } = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    assert.equal(row.ran, true);
    assert.equal(row.failed_rounds.length, 0);
    assert.equal(row.wer, 1 / 9);
    assert.match(row.notes.join(" "), /earlier attempt failed \(Retranscription failed before provider submission\) and was replaced/);
    assert.match(row.notes.join(" "), /resubmitted once/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--append adds a provider to an existing run and replaces its failed job there", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  api.getBotStatus = async () => "Done";
  let n = 0;
  const status = {};
  api.transcribe = async (_bot, provider) => {
    const name = Object.keys(provider)[0];
    const id = `t-${n++}`;
    status[id] = { name, status: name === "jigsawstack" && n === 1 ? "Failed" : "Success" };
    return { transcript_id: id };
  };
  api.listTranscriptions = async () => Object.entries(status).map(([id, s]) => ({ transcript_id: id, provider: s.name, status: s.status, error: s.status === "Failed" ? "some other MeetStream failure" : undefined }));
  api.getTranscript = async (id) => [{ start_time: 0, transcript: OUTPUTS[status[id].name === "jigsawstack" ? "meetstream" : status[id].name] }];
  try {
    const { benchmark } = require("../src/benchmark");
    const log = console.log;
    console.log = () => {};
    let runDir;
    try {
      runDir = await benchmark({ botId: "bot-5", referencePath: "reference.txt", providers: ["jigsawstack", "deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005 });
      let r = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
      assert.equal(r.providers.find((p) => p.provider === "jigsawstack").ran, false);
      const again = await benchmark({ botId: "bot-5", referencePath: "reference.txt", providers: ["jigsawstack"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005, appendTo: runDir });
      assert.equal(again, runDir);
    } finally {
      console.log = log;
    }
    const r = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
    const by = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
    assert.equal(by.jigsawstack.ran, true);
    assert.equal(by.jigsawstack.wer, 0);
    assert.match(by.jigsawstack.notes.join(" "), /submitted on its own after the rest of this run/);
    assert.equal(by.deepgram.ran, true); // untouched by the append
    const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(run.jobs.filter((j) => j.provider === "jigsawstack").length, 2);
    assert.equal(run.jobs.find((j) => j.provider === "jigsawstack" && j.status === "Failed").superseded, true);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--append refuses a run of a different recording", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("reference.txt", REFERENCE + "\n");
  fs.mkdirSync("results/r1", { recursive: true });
  fs.writeFileSync("results/r1/run.json", JSON.stringify({ run_id: "r1", bot: { id: "other-bot" }, jobs: [] }));
  try {
    const { benchmark } = require("../src/benchmark");
    await assert.rejects(
      benchmark({ botId: "bot-6", referencePath: "reference.txt", providers: ["deepgram"], rounds: 1, pollSeconds: 0.01, timeoutMinutes: 0.005, appendTo: "results/r1" }),
      /is a run of bot other-bot, not bot-6/
    );
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
