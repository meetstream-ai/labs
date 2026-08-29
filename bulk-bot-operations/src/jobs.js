import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Load, validate, and normalize the batch.
 *
 * Validation happens BEFORE any HTTP call, because a batch of 50 that dies on
 * job 37 with `meeting_link is required.` is 36 bots you did not mean to
 * create. Bad input is a local problem, so catch it locally.
 */

const STREAMING_PROVIDERS = new Set([
  'deepgram_streaming',
  'assemblyai_streaming',
  'jigsawstack_streaming',
  'meetstream_streaming',
  'meeting_captions',
]);
const POST_CALL_PROVIDERS = new Set([
  'deepgram',
  'assemblyai',
  'sarvam',
  'jigsawstack',
  'meetstream',
]);
const ALL_PROVIDERS = new Set([...STREAMING_PROVIDERS, ...POST_CALL_PROVIDERS]);

/** Accepts a JSON array, or `{ jobs: [...] }`, or one JSON object per line. */
export function loadJobs(filePath) {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) throw new Error(`${filePath} is empty`);

  let parsed;
  if (raw.startsWith('[') || raw.startsWith('{')) {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) parsed = parsed.jobs;
  } else {
    parsed = raw
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array, or { "jobs": [...] }, or JSON lines`);
  }
  return parsed;
}

/**
 * @returns {{ valid: Array<object>, invalid: Array<{index:number, id:string, errors:string[]}> }}
 */
export function validateJobs(rawJobs, defaults = {}) {
  const valid = [];
  const invalid = [];
  const seenIds = new Set();

  rawJobs.forEach((job, index) => {
    const errors = [];
    const id = String(job.id ?? job.job_id ?? `job-${index + 1}`);

    if (seenIds.has(id)) {
      errors.push(`duplicate job id "${id}". Ids must be unique: they seed the Idempotency-Key.`);
    }
    seenIds.add(id);

    // The field is meeting_link. Not meeting_url. meeting_url is what the API
    // returns, not what it accepts.
    const meetingLink = job.meeting_link ?? job.meetingLink;
    if (!meetingLink) errors.push('meeting_link is required.');
    else if (!/^https?:\/\//i.test(meetingLink)) errors.push(`meeting_link "${meetingLink}" is not a URL`);
    if (job.meeting_url && !job.meeting_link) {
      errors.push('use `meeting_link`, not `meeting_url`. meeting_url is a response field.');
    }

    const provider = job.provider ?? defaults.provider ?? 'deepgram';
    if (!ALL_PROVIDERS.has(provider)) {
      errors.push(
        `unknown provider "${provider}". Post-call: ${[...POST_CALL_PROVIDERS].join(', ')}. Streaming: ${[...STREAMING_PROVIDERS].join(', ')}.`,
      );
    }

    const callbackUrl = job.callback_url ?? defaults.callbackUrl ?? null;
    if (callbackUrl && !/^https:\/\//i.test(callbackUrl)) {
      errors.push(`callback_url must be https. Got "${callbackUrl}".`);
    }

    // Hard floor enforced by the API. Catching it here saves a 400 per job.
    const recTimeout = job.automatic_leave?.in_call_recording_timeout;
    if (recTimeout !== undefined && recTimeout < 600) {
      errors.push(`automatic_leave.in_call_recording_timeout must be at least 600 (got ${recTimeout}).`);
    }
    const denyTimeout = job.automatic_leave?.recording_permission_denied_timeout;
    if (denyTimeout !== undefined && (denyTimeout < 60 || denyTimeout > 300)) {
      errors.push(
        `automatic_leave.recording_permission_denied_timeout must be 60-300 (got ${denyTimeout}). Zoom only.`,
      );
    }

    // custom_attributes values must be strings.
    const custom = { ...(defaults.customAttributes ?? {}), ...(job.custom_attributes ?? {}) };
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v !== 'string') {
        errors.push(`custom_attributes.${k} must be a string, got ${typeof v}.`);
      }
    }

    if (errors.length) {
      invalid.push({ index, id, errors });
      return;
    }

    valid.push({
      id,
      meetingLink,
      botName: job.bot_name ?? job.botName ?? defaults.botName ?? `Bot ${id}`,
      videoRequired: job.video_required ?? defaults.videoRequired ?? false,
      joinAt: job.join_at ?? null,
      callbackUrl,
      provider,
      streamingOnly: STREAMING_PROVIDERS.has(provider),
      automaticLeave: job.automatic_leave ?? defaults.automaticLeave ?? null,
      customAttributes: custom,
    });
  });

  return { valid, invalid };
}

/**
 * Build the create_bot body. Only real fields.
 */
export function toCreateBotPayload(job) {
  const payload = {
    meeting_link: job.meetingLink,
    bot_name: job.botName,
    video_required: job.videoRequired,
    recording_config: {
      transcript: { provider: { [job.provider]: providerOptions(job.provider) } },
    },
    custom_attributes: {
      ...job.customAttributes,
      // Webhooks never carry the provider, and the provider decides where the
      // event stream ends. Stamp it. Values must be strings.
      streaming_only: String(job.streamingOnly),
      batch_job_id: job.id,
    },
  };

  if (job.callbackUrl) payload.callback_url = job.callbackUrl;
  if (job.joinAt) payload.join_at = job.joinAt;
  if (job.automaticLeave) payload.automatic_leave = job.automaticLeave;

  return payload;
}

function providerOptions(provider) {
  switch (provider) {
    case 'deepgram':
    case 'deepgram_streaming':
      return { model: 'nova-3', language: 'en' };
    case 'assemblyai':
    case 'assemblyai_streaming':
      return { language_code: 'en' };
    default:
      return {};
  }
}

/**
 * Deterministic Idempotency-Key: same batch id + same job id + same payload
 * always produces the same key.
 *
 * This is the whole point of the template. Re-running a batch that half
 * succeeded replays the finished jobs (HTTP 507) instead of creating a second
 * bot for every meeting. Folding the payload into the hash means a job you
 * deliberately EDITED gets a new key and is genuinely re-created.
 */
export function idempotencyKeyFor(batchId, job, payload) {
  return createHash('sha256')
    .update(`${batchId}|${job.id}|${JSON.stringify(payload)}`)
    .digest('hex')
    .slice(0, 40);
}
