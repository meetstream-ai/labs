import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotEventTracker, formatWebhookEvent, terminalReason } from '../src/webhookServer.js';

test('shows useful bot events and hides routine noise', () => {
  assert.equal(
    formatWebhookEvent({ event: 'bot.inmeeting', bot_event: 'bot.inmeeting', timestamp: '2026-06-16T10:00:00Z' }),
    '✅ Bot joined the meeting'
  );
  // Every ending is event bot.stopped; bot_event carries the reason.
  const stopped = (bot_event, bot_status, status_code, extra = {}) => ({
    event: 'bot.stopped', bot_event, bot_status, status_code, timestamp: '2026-06-16T10:00:00Z', ...extra
  });
  assert.equal(formatWebhookEvent(stopped('bot.stopped', 'Stopped', 200)), '✅ MeetStream reports the bot stopped');
  assert.match(formatWebhookEvent(stopped('bot.kicked', 'Stopped', 200)), /removed the bot/);
  assert.match(formatWebhookEvent(stopped('bot.notallowed', 'NotAllowed', 500)), /admitted/);
  assert.match(formatWebhookEvent(stopped('bot.denied', 'Denied', 500)), /denied/i);
  assert.match(formatWebhookEvent(stopped('bot.failed', 'FAILED', 500, { message: 'Join failed' })), /Join failed/);
  // Without bot_event, bot_status is the case-insensitive fallback.
  assert.match(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'notallowed' }), /admitted/);
  assert.match(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'Failed', message: 'boom' }), /boom/);
  assert.equal(formatWebhookEvent({ event: 'bot.stopped', bot_status: 'Stopped' }), '✅ MeetStream reports the bot stopped');
  // bot.error is non-terminal.
  assert.match(formatWebhookEvent({ event: 'bot.error', bot_event: 'bot.error', message: 'Provider quota exceeded' }), /quota/);
  assert.equal(formatWebhookEvent({ event: 'audio.processed', bot_event: 'audio.processed' }), null);
  assert.equal(formatWebhookEvent({ event: 'bot.done', bot_event: 'bot.done' }), null);
});

test('terminalReason prefers bot_event and falls back to bot_status', () => {
  assert.equal(terminalReason({ event: 'bot.stopped', bot_event: 'bot.kicked', bot_status: 'Stopped' }), 'bot.kicked');
  assert.equal(terminalReason({ event: 'bot.stopped', bot_status: 'Stopped' }), 'bot.stopped');
  assert.equal(terminalReason({ event: 'bot.stopped', bot_status: 'DENIED' }), 'bot.denied');
  assert.equal(terminalReason({ event: 'bot.stopped', bot_status: 'ERROR' }), 'bot.failed');
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
  tracker.handle({ event: 'bot.stopped', bot_event: 'bot.stopped', bot_id: 'bot-2', status_code: 200 });
  // A kick is still the terminal delivery for that bot.
  tracker.handle({ event: 'bot.stopped', bot_event: 'bot.kicked', bot_id: 'bot-1', status_code: 200 });
  await waiting;
});

test('rejects when MeetStream sends no terminal event', async () => {
  const tracker = createBotEventTracker();
  await assert.rejects(() => tracker.waitForTerminal('bot-1', 5), /did not confirm/);
});
