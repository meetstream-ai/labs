import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotEventTracker, formatWebhookEvent, startWebhookServer } from '../src/webhookServer.js';

test('webhook tracking resolves only the exact terminal bot', async () => {
  const tracker = createBotEventTracker();
  const waiting = tracker.waitForTerminal('bot-1', 100);
  tracker.handle({ bot_id: 'bot-2', bot_event: 'bot.stopped' });
  tracker.handle({ bot_id: 'bot-1', bot_event: 'bot.stopped' });
  await waiting;
});

test('webhook formatting is concise and omits raw bodies', () => {
  assert.equal(formatWebhookEvent({ bot_event: 'bot.inmeeting', secret: 'hidden' }), '✅ Bot joined the meeting');
  assert.equal(formatWebhookEvent({ bot_event: 'unknown', raw: 'hidden' }), null);
});

test('webhook server accepts events and rejects invalid JSON', async (context) => {
  let received;
  const server = await startWebhookServer(0, (event) => { received = event; });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  let response = await fetch(`http://127.0.0.1:${port}/webhooks/meetstream`, {
    method: 'POST', body: JSON.stringify({ bot_id: 'bot-1', bot_event: 'bot.recording' })
  });
  assert.equal(response.status, 200);
  assert.equal(received.bot_id, 'bot-1');
  response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', body: '{' });
  assert.equal(response.status, 400);
});
