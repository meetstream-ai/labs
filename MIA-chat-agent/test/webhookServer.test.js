import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotEventTracker, formatWebhookEvent } from '../src/webhookServer.js';

test('shows useful bot events and hides routine noise', () => {
  // Live API sends `event` (not `bot_event`).
  assert.equal(formatWebhookEvent({ event: 'bot.inmeeting' }), '✅ Bot joined the meeting');
  assert.equal(formatWebhookEvent({ event: 'bot.stopped' }), '✅ MeetStream reports the bot stopped');
  // bot.stopped is the ONE terminal event - bot_status carries the reason.
  assert.match(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'NotAllowed' }), /admitted/);
  assert.match(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'Denied' }), /denied/i);
  assert.match(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'Error', message: 'Join failed' }), /Join failed/);
  // bot.error is non-terminal.
  assert.match(formatWebhookEvent({ event: 'bot.error', message: 'Provider quota exceeded' }), /quota/);
  assert.equal(formatWebhookEvent({ event: 'audio.processed' }), null);
  // legacy `bot_event` alias still tolerated
  assert.equal(formatWebhookEvent({ bot_event: 'bot.inmeeting' }), '✅ Bot joined the meeting');
});

test('shows live transcription in the terminal', () => {
  assert.equal(formatWebhookEvent({ new_text: 'Okay assistant' }), 'Heard: Okay assistant');
  assert.equal(
    formatWebhookEvent({ channel: { alternatives: [{ transcript: 'What is two times two?' }] } }),
    'Heard: What is two times two?'
  );
});

test('confirms only the matching bot terminal event', async () => {
  const tracker = createBotEventTracker();
  const waiting = tracker.waitForTerminal('bot-1', 100);
  tracker.handle({ event: 'bot.stopped', bot_id: 'bot-2' });
  tracker.handle({ event: 'bot.stopped', bot_id: 'bot-1' });
  await waiting;
});

test('rejects when MeetStream sends no terminal event', async () => {
  const tracker = createBotEventTracker();
  await assert.rejects(() => tracker.waitForTerminal('bot-1', 5), /did not confirm/);
});
