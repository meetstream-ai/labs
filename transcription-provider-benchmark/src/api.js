const axios = require("axios");

const API_BASE = "https://api.meetstream.ai/api/v1";

function client() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("  MEETSTREAM_API_KEY is not set in your .env file.");
    process.exit(1);
  }
  return axios.create({
    baseURL: API_BASE,
    // remove_bot only answers once the bot has actually left the call,
    // which takes several seconds on a real meeting.
    timeout: 60_000,
    headers: {
      Authorization: `Token ${process.env.MEETSTREAM_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
}

/** POST /bots/create_bot. Returns the raw response body. */
async function createBot(payload) {
  const { data } = await client().post("/bots/create_bot", payload);
  return data;
}

/**
 * GET /bots/{id}/status. One of Scheduled, Joining, InWaitingRoom,
 * InMeeting, Recording, Leaving, Stopped, MediaProcessing, Done,
 * Failed, Denied, NotAllowed.
 */
async function getBotStatus(botId) {
  const { data } = await client().get(`/bots/${botId}/status`);
  return String((data && typeof data === "object" ? data.status : data) ?? "");
}

/**
 * GET /bots/{id}: why a bot failed, from the last message in its status
 * timeline that isn't routine ("Bot is leaving the meeting"). null if none.
 */
async function getFailureReason(botId) {
  const { data } = await client().get(`/bots/${botId}`);
  const timeline = data?.bot_details?.StatusTimeline ?? {};
  const steps = Object.entries(timeline)
    .filter(([, s]) => s?.status && s.message && !/^Bot is (leaving|joining)/i.test(s.message))
    .sort((a, b) => String(a[1].timestamp).localeCompare(String(b[1].timestamp)));
  return steps.length ? steps[steps.length - 1][1].message : null;
}

/**
 * GET /bots/{id}: why a finished bot has no usable recording, or null. Covers
 * MeetStream reporting no captured audio ("No usable mixed audio was
 * captured") and a bot that stopped on a failure ("Failed: Recording
 * permission timeout", Zoom's host never granted recording).
 */
async function getRecordingProblem(botId) {
  return (await getRecordingState(botId)).problem;
}

/**
 * GET /bots/{id}: whether a stopped bot's recording is ready to transcribe.
 * Zoom bots keep the status "Stopped" after post-call processing has finished
 * (Meet and Teams bots move on to "Done"), so readiness is read from the
 * details: audio captured, and "Done" in the status timeline.
 */
async function getRecordingState(botId) {
  const { data } = await client().get(`/bots/${botId}`);
  const d = data?.bot_details ?? {};
  const timeline = d.StatusTimeline ?? {};
  let problem = null;
  if (/no audio/i.test(String(d.AudioStatus ?? ""))) problem = d.AudioMessage || d.AudioStatus;
  else {
    const failed = Object.values(timeline).find((s) => s?.status && /^(Failed|Error)\b/i.test(s.message ?? ""));
    if (failed) problem = failed.message;
  }
  const ready = !problem && /success/i.test(String(d.AudioStatus ?? "")) && Boolean(timeline.Done?.status);
  return { ready, problem };
}

async function removeBot(botId) {
  const { data } = await client().get(`/bots/${botId}/remove_bot`);
  return data;
}

/**
 * POST /bots/{id}/transcribe. Runs the bot's existing recording through
 * `provider` again, so every provider sees byte-identical audio.
 * Returns { bot_id, transcript_id, provider, message }.
 */
async function transcribe(botId, provider) {
  const { data } = await client().post(`/bots/${botId}/transcribe`, { provider });
  return data;
}

/** GET /bots/{id}/transcriptions. Every transcription job for the bot. */
async function listTranscriptions(botId) {
  const { data } = await client().get(`/bots/${botId}/transcriptions`);
  return data?.transcriptions ?? [];
}

/** GET /transcript/{id}/get_transcript. The formatted, speaker-labelled transcript. */
async function getTranscript(transcriptId, { raw = false } = {}) {
  const { data } = await client().get(`/transcript/${transcriptId}/get_transcript`, {
    params: raw ? { raw: "true" } : undefined,
  });
  return data;
}

/** Turns an axios error into one line that is safe to print and to save in results. */
function describeError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const detail =
    typeof body === "string" ? body : body ? JSON.stringify(body) : err.message;
  return status ? `HTTP ${status}: ${detail}` : detail;
}

module.exports = {
  createBot,
  getBotStatus,
  getFailureReason,
  getRecordingProblem,
  getRecordingState,
  removeBot,
  transcribe,
  listTranscriptions,
  getTranscript,
  describeError,
};
