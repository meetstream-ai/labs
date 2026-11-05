import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTranscript, toTurns, verifyBot } from '../src/verify.js';
import { startMock } from './mock.js';

const BOT = 'bot-1';
const SEGMENTS = [
  { speaker: 'Alex', start_time: 12, transcript: 'Gok, can you hear us?' },
  { speaker: 'Alex', start_time: 18, transcript: "Yes. I can hear you. I'm ready to participate in the meeting." },
  { speaker: 'Alex', start_time: 30, transcript: '   ' }
];

test('toTurns reads speaker + transcript and drops empty segments', () => {
  const turns = toTurns(SEGMENTS);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { start: 12, speaker: 'Alex', text: 'Gok, can you hear us?' });
});

test('checkTranscript passes when the expected phrases are heard, ignoring case and punctuation', () => {
  const result = checkTranscript(SEGMENTS, { expect: ['I CAN HEAR YOU', 'ready to participate in the meeting'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.ok(result.words >= 10);
});

test('checkTranscript fails and names the phrase that was not heard', () => {
  const result = checkTranscript(SEGMENTS, { expect: ['launch the product'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['launch the product']);
});

test('checkTranscript fails when there is barely any speech', () => {
  const result = checkTranscript([{ speaker: 'A', transcript: 'hello there' }], { minWords: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.words, 2);
});

test('checkTranscript copes with an empty transcript', () => {
  assert.equal(checkTranscript([]).ok, false);
  assert.equal(checkTranscript(undefined).words, 0);
});

// ---- verifyBot against the mock API --------------------------------------------------

let mock;
let transcripts;
let detailStatus;
let reads;

function respond(call) {
  const { method, path } = call;
  if (method === 'GET' && path === `/bots/${BOT}/detail`) {
    return detailStatus === 'PENDING' ? [202, {}] : [200, { bot_details: { Status: detailStatus, Duration: 119 } }];
  }
  if (method === 'GET' && path === `/bots/${BOT}/transcriptions`) return [200, { transcriptions: transcripts }];
  if (method === 'POST' && path === `/bots/${BOT}/transcribe`) {
    transcripts = [{ transcript_id: 'tr-new', status: 'Success' }];
    return [200, { transcript_id: 'tr-new', message: 'Transcription processing started' }];
  }
  if (method === 'GET' && path.endsWith('/get_transcript')) {
    reads += 1;
    return reads === 1 ? [202, {}] : [200, SEGMENTS];
  }
  return [404, { message: 'unexpected route' }];
}

beforeEach(async () => {
  transcripts = [];
  detailStatus = 'Done';
  reads = 0;
  mock = await startMock(respond);
});
afterEach(async () => {
  await mock.close();
});

const verify = (opts = {}) => verifyBot('test-key', BOT, { log: () => {}, ...opts });
const routes = () => mock.calls.map((c) => `${c.method} ${c.path}`);

test('verifyBot reads an existing transcript, waits through a 202, and does not transcribe again', async () => {
  transcripts = [{ transcript_id: 'tr-1', status: 'Success' }];
  const result = await verify({ expect: ['i can hear you'] });

  assert.equal(result.ok, true);
  assert.equal(result.transcriptId, 'tr-1');
  assert.equal(routes().some((r) => r.endsWith('/transcribe')), false);
  assert.equal(reads, 2, 'polled once through the 202');
});

test('verifyBot skips failed transcription runs and uses the successful one', async () => {
  transcripts = [
    { transcript_id: 'tr-ok', status: 'Success' },
    { transcript_id: 'tr-bad', status: 'Failed' }
  ];
  assert.equal((await verify()).transcriptId, 'tr-ok');
});

test('verifyBot without a transcript explains how to get one instead of guessing', async () => {
  await assert.rejects(verify(), /no post-call transcript.*--transcribe.*TRANSCRIBE=true/s);
  assert.equal(routes().some((r) => r.endsWith('/transcribe')), false);
});

test('verifyBot --transcribe creates the transcript from the stored audio, then checks it', async () => {
  const result = await verify({ transcribe: true, expect: ['ready to participate in the meeting'] });

  const call = mock.calls.find((c) => c.path.endsWith('/transcribe'));
  assert.deepEqual(Object.keys(call.body.provider), ['deepgram']);
  assert.equal(result.transcriptId, 'tr-new');
  assert.equal(result.ok, true);
});

test('verifyBot refuses a bot that is still in the call', async () => {
  detailStatus = 'InMeeting';
  await assert.rejects(verify(), /"InMeeting".*Done/s);
});

test('verifyBot says so when MeetStream is still assembling the bot record', async () => {
  detailStatus = 'PENDING';
  await assert.rejects(verify(), /not finished assembling/);
});

test('checkTranscript counts the lines labelled with the bot\'s own name, as extra evidence', () => {
  const segs = [
    { speaker: 'Alex', start_time: 1, transcript: 'Hello? Hello.' },
    { speaker: 'Grok', start_time: 4, transcript: "Go on. I'm right here." },
    { speaker: 'grok', start_time: 9, transcript: 'What is the second?' }
  ];
  assert.equal(checkTranscript(segs, { botName: 'Grok' }).botTurns, 2);
  assert.equal(checkTranscript(segs).botTurns, 0, 'no bot name, nothing to count');
});

test('verifyBot passes the bot name from the call record to the check', async () => {
  transcripts = [{ transcript_id: 'tr-1', status: 'Success' }];
  mock.overrides[`GET /bots/${BOT}/detail`] = () => [200, { bot_details: { Status: 'Done', BotUsername: 'Alex' } }];
  assert.equal((await verify()).botTurns, 2);
});
