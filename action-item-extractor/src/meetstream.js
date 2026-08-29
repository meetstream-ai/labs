/**
 * Minimal MeetStream API client.
 *
 * Node 18+, ESM, built-in fetch. No SDK required.
 *
 * Ground rules baked in here (they are the things people get wrong):
 *   - Auth header is `Authorization: Token <key>` - the literal word `Token`, not `Bearer`.
 *   - Errors come back as `{ "message": "..." }`.
 *   - HTTP 202 means "still processing, poll again" - it is NOT a success payload.
 *   - HTTP 507 means "idempotent replay" - treat it as SUCCESS.
 *   - The transcript is fetched by `transcript_id`, NOT by `bot_id`.
 *   - Transcript segments carry their text in a field called `transcript`, NOT `text`.
 */

const DEFAULT_BASE_URL = "https://api.meetstream.ai/api/v1";

/** Statuses that are worth retrying automatically. */
const TRANSIENT_STATUSES = new Set([429, 500, 503]);

export class MeetStreamError extends Error {
  constructor(status, message, body) {
    super(`MeetStream API error ${status}: ${message}`);
    this.name = "MeetStreamError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Read a required env var or exit with a clear, actionable message.
 * @param {string} name
 * @param {string} [hint]
 * @returns {string}
 */
export function requireEnv(name, hint = "") {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`\n  Missing required environment variable: ${name}`);
    if (hint) console.error(`  ${hint}`);
    console.error("  Copy .env.example to .env and fill in the values.\n");
    process.exit(1);
  }
  return String(value).trim();
}

function baseUrl() {
  return (process.env.MEETSTREAM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform a request against the MeetStream API.
 *
 * @param {string} path                 Path after /api/v1, e.g. "/bots/create_bot"
 * @param {object} [options]
 * @param {string} [options.method]     HTTP method (default GET)
 * @param {object} [options.body]       JSON body
 * @param {object} [options.query]      Query string params
 * @param {string} [options.idempotencyKey] Sent as `Idempotency-Key`; a replay returns 507
 * @param {number} [options.retries]    Retries for 429/500/503 (default 3)
 * @returns {Promise<{ status: number, data: any, replayed: boolean }>}
 *          `status === 202` means "not ready yet" - the caller decides whether to poll.
 * @throws  {MeetStreamError} on any non-transient failure
 */
export async function apiRequest(path, options = {}) {
  const { method = "GET", body, query, idempotencyKey, retries = 3 } = options;

  const apiKey = requireEnv(
    "MEETSTREAM_API_KEY",
    "Create one at https://app.meetstream.ai under API Keys."
  );

  const url = new URL(baseUrl() + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers = { Authorization: `Token ${apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (networkError) {
      lastError = networkError;
      if (attempt > retries) throw networkError;
      await sleep(1000 * attempt);
      continue;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    // 202 = still processing. Hand it back so the caller can poll.
    if (res.status === 202) return { status: 202, data, replayed: false };

    // 507 = idempotent replay of a request we already made. That is a success.
    if (res.status === 507) return { status: 507, data, replayed: true };

    if (res.ok) return { status: res.status, data, replayed: false };

    const message =
      (data && typeof data === "object" && data.message) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      "Unknown error";

    if (TRANSIENT_STATUSES.has(res.status) && attempt <= retries) {
      lastError = new MeetStreamError(res.status, message, data);
      const waitMs = 1000 * attempt * (res.status === 429 ? 3 : 1);
      console.warn(
        `  ${method} ${path} → HTTP ${res.status} (${message}). Retrying in ${waitMs}ms ` +
          `(attempt ${attempt}/${retries})`
      );
      await sleep(waitMs);
      continue;
    }

    throw new MeetStreamError(res.status, message, data);
  }

  throw lastError ?? new Error(`Request to ${path} failed`);
}

/* ------------------------------------------------------------------ */
/* Bots                                                                */
/* ------------------------------------------------------------------ */

/**
 * Build a `recording_config.transcript.provider` object from simple env-style inputs.
 *
 * IMPORTANT: pick exactly ONE provider key. Streaming providers
 * (`*_streaming`, `meeting_captions`) never produce a post-call transcript -
 * `/transcript/{id}/get_transcript` will return 202 forever for those.
 *
 * @param {string} provider  deepgram | assemblyai | sarvam | jigsawstack | meetstream
 * @param {string} language
 */
export function buildTranscriptProvider(provider = "meetstream", language = "en") {
  switch (provider) {
    case "deepgram":
      return { deepgram: { model: "nova-3", language, diarize: true } };
    case "assemblyai":
      return { assemblyai: { speech_models: [], language_code: language } };
    case "sarvam":
      return { sarvam: { language } };
    case "jigsawstack":
      return { jigsawstack: { language } };
    case "meetstream":
      return { meetstream: { language } };
    default:
      throw new Error(
        `Unknown post-call transcription provider "${provider}". ` +
          `Use one of: deepgram, assemblyai, sarvam, jigsawstack, meetstream. ` +
          `Streaming providers do not produce a post-call transcript.`
      );
  }
}

/**
 * Create a bot that joins a meeting.
 *
 * Only real create_bot fields are sent. Note `meeting_link` (not meeting_url)
 * and `video_required` (a boolean, not a recording mode string).
 *
 * @returns {Promise<{ bot_id: string, transcript_id: string|null, status: string|undefined }>}
 */
export async function createBot({
  meetingLink,
  botName = "MeetStream Labs Bot",
  callbackUrl,
  videoRequired = false,
  transcriptProvider,
  retentionHours,
  joinAt,
  customAttributes,
  automaticLeave,
  idempotencyKey,
}) {
  if (!meetingLink) throw new Error("createBot: meetingLink is required");

  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: Boolean(videoRequired),
  };

  if (callbackUrl) body.callback_url = callbackUrl;
  if (joinAt) body.join_at = joinAt;
  if (customAttributes) body.custom_attributes = customAttributes;
  if (automaticLeave) body.automatic_leave = automaticLeave;

  if (transcriptProvider) {
    body.recording_config = { transcript: { provider: transcriptProvider } };
    if (retentionHours) {
      body.recording_config.retention = { type: "timed", hours: Number(retentionHours) };
    }
  }

  const { data, replayed } = await apiRequest("/bots/create_bot", {
    method: "POST",
    body,
    idempotencyKey,
  });

  if (replayed) console.log("  Idempotent replay (HTTP 507) - reusing the existing bot.");

  return {
    bot_id: data?.bot_id ?? data?.id ?? null,
    transcript_id: data?.transcript_id ?? null,
    meeting_url: data?.meeting_url ?? meetingLink,
    status: data?.status,
    raw: data,
  };
}

/** GET /bots/{id}/status */
export async function getBotStatus(botId) {
  const { data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/status`);
  return data;
}

/** GET /bots/{id}/detail */
export async function getBotDetail(botId) {
  const { data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/detail`);
  return data;
}

/** GET /bots/{id}/summary - MeetStream's AI-generated meeting summary. */
export async function getBotSummary(botId) {
  const { status, data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/summary`);
  if (status === 202) return null; // summary still generating
  return data;
}

/** GET /bots/{id}/get_participants */
export async function getParticipants(botId) {
  const { data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/get_participants`);
  return data;
}

/** GET /bots/{id}/get_speaker_timeline */
export async function getSpeakerTimeline(botId) {
  const { status, data } = await apiRequest(
    `/bots/${encodeURIComponent(botId)}/get_speaker_timeline`
  );
  if (status === 202) return null;
  return data;
}

/** GET /bots/{id}/transcriptions */
export async function listTranscriptions(botId) {
  const { data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/transcriptions`);
  return data;
}

/** GET /bots/{id}/remove_bot - yes, this one is a GET. Makes the bot leave the call. */
export async function removeBot(botId) {
  const { data } = await apiRequest(`/bots/${encodeURIComponent(botId)}/remove_bot`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Transcript                                                          */
/* ------------------------------------------------------------------ */

/**
 * GET /transcript/{transcript_id}/get_transcript
 * Returns `null` while the transcript is still being generated (HTTP 202).
 */
export async function getTranscript(transcriptId, { raw = false } = {}) {
  if (!transcriptId) throw new Error("getTranscript: transcriptId is required");
  const { status, data } = await apiRequest(
    `/transcript/${encodeURIComponent(transcriptId)}/get_transcript`,
    { query: { raw: String(Boolean(raw)) } }
  );
  return status === 202 ? null : data;
}

/**
 * Poll `get_transcript` until it stops returning 202.
 *
 * The retry cap matters: a bot configured with a streaming-only provider
 * (`deepgram_streaming`, `meeting_captions`, ...) returns 202 forever, because
 * those providers never write a post-call transcript.
 */
export async function waitForTranscript(
  transcriptId,
  { attempts = 20, intervalMs = 5000, onWait } = {}
) {
  for (let i = 1; i <= attempts; i++) {
    const data = await getTranscript(transcriptId);
    if (data) return data;
    if (i === attempts) break;
    if (onWait) onWait(i, attempts);
    else console.log(`  Transcript not ready (HTTP 202) - retry ${i}/${attempts} in ${intervalMs}ms`);
    await sleep(intervalMs);
  }
  throw new Error(
    `Transcript ${transcriptId} still returned HTTP 202 after ${attempts} attempts. ` +
      `If the bot used a streaming-only transcription provider there will never be a ` +
      `post-call transcript - use a post-call provider such as "deepgram" or "meetstream".`
  );
}

/**
 * Normalise a transcript payload into a flat list of segments.
 *
 * The MeetStream segment shape is `{ speaker, transcript }` - the text lives in
 * `transcript`, NOT in `text`. We keep that field name so the normalised object
 * still reads like the API. A couple of tolerant fallbacks are included so this
 * keeps working if you enable `raw=true` or a different provider shape.
 *
 * @returns {Array<{ speaker: string, transcript: string, start_time: number|null, end_time: number|null }>}
 */
export function extractSegments(payload) {
  const list =
    [payload, payload?.transcript, payload?.segments, payload?.data, payload?.message].find(
      Array.isArray
    ) ?? [];

  return list
    .map((segment) => {
      if (typeof segment === "string") {
        return { speaker: "Unknown speaker", transcript: segment, start_time: null, end_time: null };
      }
      const speaker =
        segment?.speaker ?? segment?.participant?.name ?? segment?.speaker_name ?? "Unknown speaker";

      // `transcript` is the real field. `text` / `words` are tolerant fallbacks.
      let text = typeof segment?.transcript === "string" ? segment.transcript : null;
      if (text === null && typeof segment?.text === "string") text = segment.text;
      if (text === null && Array.isArray(segment?.words)) {
        text = segment.words.map((w) => w?.text ?? w?.word ?? "").join(" ");
      }

      return {
        speaker: String(speaker),
        transcript: (text ?? "").trim(),
        start_time: toNumber(segment?.start_time ?? segment?.start_timestamp?.relative),
        end_time: toNumber(segment?.end_time ?? segment?.end_timestamp?.relative),
      };
    })
    .filter((segment) => segment.transcript.length > 0);
}

/** Render segments as `Speaker: line` text, ready to hand to an LLM or drop into a doc. */
export function segmentsToPlainText(segments, { withTimestamps = false } = {}) {
  return segments
    .map((segment) => {
      const stamp =
        withTimestamps && segment.start_time != null ? `[${formatClock(segment.start_time)}] ` : "";
      return `${stamp}${segment.speaker}: ${segment.transcript}`;
    })
    .join("\n");
}

/**
 * Normalise `get_speaker_timeline` into `{ speaker, start_time, end_time, duration }` entries.
 * Returns `[]` if the payload has no usable durations.
 */
export function normalizeSpeakerTimeline(payload) {
  const list =
    [payload, payload?.speaker_timeline, payload?.timeline, payload?.data, payload?.message].find(
      Array.isArray
    ) ?? [];

  return list
    .map((entry) => {
      const speaker = entry?.speaker ?? entry?.participant?.name ?? entry?.name ?? "Unknown speaker";
      const start = toNumber(entry?.start_time ?? entry?.start ?? entry?.start_timestamp?.relative);
      const end = toNumber(entry?.end_time ?? entry?.end ?? entry?.end_timestamp?.relative);
      let duration = toNumber(entry?.duration);
      if (duration == null && start != null && end != null) duration = end - start;
      return { speaker: String(speaker), start_time: start, end_time: end, duration };
    })
    .filter((entry) => entry.duration != null && entry.duration >= 0);
}

/** Normalise `get_participants` into `{ name, email }` records. */
export function normalizeParticipants(payload) {
  const list =
    [payload, payload?.participants, payload?.data, payload?.message].find(Array.isArray) ?? [];

  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const name =
      (typeof entry === "string" ? entry : entry?.name ?? entry?.participant_name ?? entry?.display_name) ||
      null;
    const email = typeof entry === "object" ? entry?.email ?? entry?.email_address ?? null : null;
    const key = `${name ?? ""}|${email ?? ""}`;
    if (!name && !email) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name ? String(name) : null, email: email ? String(email) : null });
  }
  return out;
}

/**
 * Pull a plain-text summary out of the `/bots/{id}/summary` payload.
 * The endpoint's exact JSON shape can vary by account configuration, so we probe
 * the likely string fields and fall back to the pretty-printed JSON.
 */
export function summaryToText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  for (const key of ["summary", "meeting_summary", "text", "content", "message", "data"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (Array.isArray(payload?.summary)) return payload.summary.filter(Boolean).join("\n");
  return JSON.stringify(payload, null, 2);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Seconds → mm:ss (or h:mm:ss past an hour). */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export { sleep };
