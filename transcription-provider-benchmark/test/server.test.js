/**
 * The local server, on a throwaway data folder. Nothing here reaches
 * MeetStream: every request is either answered locally or refused by
 * validation before a bot could be sent.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "server-"));
process.env.BENCH_DATA_DIR = DATA;
delete process.env.MEETSTREAM_API_KEY;
delete process.env.NGROK_AUTHTOKEN;

const RECORDER = "11111111-1111-4111-8111-111111111111";
const SPEAKER = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";

// A past two-bot run of RECORDER (sample clip, with its reference), and a
// speed-only run of LIVE (people talking, no reference).
function seedRun(id, { bot, speaker = null, clip = null, reference }) {
  const dir = path.join(DATA, "results", id);
  fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
  const text = "the quick brown fox jumps over the lazy dog";
  fs.writeFileSync(path.join(dir, "transcripts", "deepgram.r1.json"), JSON.stringify([{ start_time: 0, transcript: text }]));
  if (reference) fs.writeFileSync(path.join(dir, "reference.txt"), text + "\n");
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({
    run_id: id, bot: { id: bot }, environment: { poll_seconds: 1 }, providers: { deepgram: {} }, rounds: 1,
    recording: { bot_id: bot, speaker_bot_id: speaker, meeting_platform: "meet.google.com", clip, played_at: "2026-09-28T18:05:02Z" },
    reference: reference ? { file: "reference.txt", sha256: "0".repeat(64) } : null,
    jobs: [{ provider: "deepgram", status: "Success", round: 1, transcript_file: "transcripts/deepgram.r1.json", turnaround_s: 3, turnaround_lower_bound_s: 1 }],
  }));
  require("../src/report").score(dir);
}
seedRun("2026-01-01T00-00-00Z", { bot: RECORDER, speaker: SPEAKER, clip: { path: "sample/clip.wav", sha256: "0".repeat(64), seconds: 10 }, reference: true });
seedRun("2026-01-02T00-00-00Z", { bot: LIVE, reference: false });

const { start } = require("../server");
let port, server;
test.before(async () => ({ server, port } = await start({ port: 0 })));
test.after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function request(method, url, { body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers: { Host: host ?? `127.0.0.1:${port}`, ...(data ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("only requests addressed to this machine are answered (DNS rebinding)", async () => {
  assert.equal((await request("GET", "/api/status")).status, 200);
  assert.equal((await request("GET", "/api/status", { host: `localhost:${port}` })).status, 200);
  assert.equal((await request("GET", "/api/status", { host: `evil.example:${port}` })).status, 403);
  assert.equal((await request("POST", "/api/keys", { host: "evil.example", body: { MEETSTREAM_API_KEY: "x" } })).status, 403);
});

test("a bot is recognised from a past run, without sending its reference's location to the page", async () => {
  const rec = (await request("GET", `/api/recordings/${RECORDER}`)).json;
  assert.equal(rec.known, true);
  assert.equal(rec.source, "sample");
  assert.equal(rec.reference.words, 9);
  assert.equal(rec.referencePath, undefined);
  assert.deepEqual(rec.pastRuns.map((r) => r.id), ["2026-01-01T00-00-00Z"]);
  assert.equal((await request("GET", `/api/recordings/${SPEAKER}`)).json.speaker, true);
  const unknown = (await request("GET", "/api/recordings/44444444-4444-4444-8444-444444444444")).json;
  assert.deepEqual([unknown.known, unknown.pastRuns], [false, []]);
  assert.equal((await request("GET", "/api/recordings/..%2F..%2Fetc")).status, 400);
});

test("a reference that doesn't fit the audio, or a speaker bot, is refused before any bot is sent", async () => {
  await request("POST", "/api/keys", { body: { MEETSTREAM_API_KEY: "fake-for-validation", NGROK_AUTHTOKEN: "fake" } });
  const job = (body) => request("POST", "/api/jobs", { body: { providers: ["deepgram"], ...body } });
  const meeting = "https://meet.google.com/abc-defg-hij";
  const refused = [
    { mode: "recorder", meetingLink: meeting, reference: { kind: "sample" } },
    { mode: "two-bot", meetingLink: meeting, audio: { kind: "upload", name: "a.wav", base64: "AA==" }, reference: { kind: "sample" } },
    { mode: "two-bot", meetingLink: meeting, audio: { kind: "sample" }, reference: { kind: "text", text: "hi" } },
    { mode: "existing", botId: RECORDER, reference: { kind: "sample" } },
    { mode: "existing", botId: LIVE, reference: { kind: "saved" } },
  ];
  for (const body of refused) {
    const r = await job(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, /doesn't fit this audio/);
  }
  const speaker = await job({ mode: "existing", botId: SPEAKER, reference: { kind: "none" } });
  assert.equal(speaker.status, 400);
  assert.match(speaker.json.error, /speaker bot/);
});

test("settings say where each key came from, never what it is, and a key can be removed", async () => {
  await request("POST", "/api/keys", { body: { MEETSTREAM_API_KEY: "secret-key-value" } });
  let settings = await request("GET", "/api/settings");
  assert.equal(settings.status, 200);
  assert.doesNotMatch(settings.text, /secret-key-value/);
  assert.deepEqual(settings.json.keys.MEETSTREAM_API_KEY, { set: true, source: "session" }); // no key store: memory only
  assert.equal(settings.json.persistent, false);
  assert.equal(settings.json.storage.path, DATA);
  assert.ok(settings.json.storage.runs > 0);
  const cleared = await request("POST", "/api/keys", { body: { clear: ["MEETSTREAM_API_KEY"] } });
  assert.equal(cleared.json.hasKey, false);
  settings = await request("GET", "/api/settings");
  assert.deepEqual(settings.json.keys.MEETSTREAM_API_KEY, { set: false, source: null });
  assert.equal((await request("POST", "/api/data-folder/open")).status, 400); // not the desktop app
});

test("each provider's record across saved runs is pooled over scored runs only", async () => {
  const { providers } = (await request("GET", "/api/providers")).json;
  const deepgram = providers.find((p) => p.key === "deepgram");
  assert.equal(deepgram.stats.runs, 2);
  assert.equal(deepgram.stats.words, 9); // the speed-only run adds no words
  assert.equal(deepgram.stats.wer, 0);
  assert.equal(providers.find((p) => p.key === "sarvam").stats, null);
});

test("adding what was said to a speed-only run scores it, once", async () => {
  const id = "2026-01-02T00-00-00Z";
  assert.equal((await request("GET", `/api/runs/${id}`)).json.results.reference_words, null);
  const added = await request("POST", `/api/runs/${id}/reference`, { body: { text: "the quick brown fox jumps over the lazy dog" } });
  assert.equal(added.status, 200, added.text);
  const run = (await request("GET", `/api/runs/${id}`)).json;
  assert.equal(run.results.reference_words, 9);
  assert.equal(run.results.providers[0].wer, 0);
  const again = await request("POST", `/api/runs/${id}/reference`, { body: { text: "something else" } });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /already has a reference/);
  assert.equal((await request("POST", "/api/runs/..%2F..%2Fx/reference", { body: { text: "x" } })).status, 404);
});
