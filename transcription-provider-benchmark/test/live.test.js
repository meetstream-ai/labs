const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../src/api");
const { timeLiveTranscript } = require("../src/recorder");

test("a live provider's transcript is timed from the bots leaving the call", async () => {
  let polls = 0;
  api.listTranscriptions = async () => {
    polls++;
    return [
      { transcript_id: null, provider: "meeting_captions", status: "Success" },
      { transcript_id: "live-1", provider: "assemblyai", status: polls < 3 ? "Processing" : "Success" },
    ];
  };
  const log = console.log;
  console.log = () => {};
  try {
    const leftAt = Date.now();
    const r = await timeLiveTranscript("bot-1", "assemblyai", leftAt, 20);
    assert.equal(r.transcript_id, "live-1");
    assert.equal(r.status, "Success");
    assert.equal(polls, 3);
    assert.ok(r.turnaround_after_leaving_s >= 0.05 && r.turnaround_after_leaving_s < 1, `${r.turnaround_after_leaving_s}s`);
    assert.ok(r.turnaround_after_leaving_lower_bound_s <= r.turnaround_after_leaving_s);
  } finally {
    console.log = log;
  }
});
