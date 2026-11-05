// Checks a finished call's recorded audio, so "Grok spoke" rests on evidence and
// not on someone having listened.
//
// MeetStream records the whole call as one mixed channel, and a bot's speech is part
// of that mix. Speaker labels are a bonus, not a guarantee: in one call the bot's lines
// came back labelled with its own name, in another every line carried the only named
// participant. The pass/fail check is therefore on content: was there speech at all,
// and do the phrases Grok was guided to say appear in it. Lines labelled with the bot's
// name are reported as extra evidence when they exist.

import { getBotDetail, getTranscript, listTranscriptions, startTranscription } from './api.js';

const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();

/** Segments use `speaker` + `transcript`, not `text`. */
export function toTurns(segments) {
  return (segments || [])
    .map((s) => ({ start: s.start_time ?? null, speaker: s.speaker ?? 'Unknown', text: String(s.transcript ?? '').trim() }))
    .filter((t) => t.text);
}

export function checkTranscript(segments, { expect = [], minWords = 10, botName = '' } = {}) {
  const turns = toTurns(segments);
  const spoken = normalize(turns.map((t) => t.text).join(' '));
  const words = spoken ? spoken.split(' ').length : 0;
  const found = expect.filter((phrase) => spoken.includes(normalize(phrase)));
  const missing = expect.filter((phrase) => !found.includes(phrase));
  const botTurns = botName ? turns.filter((t) => t.speaker.toLowerCase() === botName.toLowerCase()).length : 0;
  return { ok: words >= minWords && missing.length === 0, words, minWords, found, missing, turns, botName, botTurns };
}

const POST_CALL_PROVIDER = { deepgram: { model: 'nova-3', language: 'en', smart_format: true, punctuate: true } };

/**
 * Fetch the transcript of a finished bot and check it. With `transcribe`, run
 * post-call transcription first when the bot has none (a bot created without
 * TRANSCRIBE=true has none).
 */
export async function verifyBot(apiKey, botId, { expect = [], minWords = 10, transcribe = false, log = console.log } = {}) {
  const detail = await getBotDetail(apiKey, botId);
  const status = detail?.Status || detail?.status;
  if (!status) throw new Error(`MeetStream has not finished assembling bot ${botId}. Try again shortly.`);
  if (String(status).toLowerCase() !== 'done') {
    throw new Error(`Bot ${botId} is "${status}". Wait until its post-call processing is "Done", then verify.`);
  }
  log(`Bot ${botId}: ${status}, ${detail.Duration ?? '?'}s in the call`);

  let runs = (await listTranscriptions(apiKey, botId)).filter((r) => r.status !== 'Failed');
  let transcriptId = runs.at(-1)?.transcript_id;

  if (!transcriptId) {
    if (!transcribe) {
      throw new Error(
        'This bot has no post-call transcript. Run again with --transcribe to create one from the stored audio, ' +
          'or start future runs with TRANSCRIBE=true.'
      );
    }
    log('No transcript yet; transcribing the stored audio...');
    const started = await startTranscription(apiKey, botId, POST_CALL_PROVIDER);
    transcriptId = started.transcript_id;
    if (!transcriptId) throw new Error(`MeetStream accepted the transcription but returned no transcript_id: ${JSON.stringify(started)}`);
  }

  const segments = await getTranscript(apiKey, transcriptId);
  const result = checkTranscript(segments, { expect, minWords, botName: detail.BotUsername || '' });
  result.transcriptId = transcriptId;
  return result;
}


