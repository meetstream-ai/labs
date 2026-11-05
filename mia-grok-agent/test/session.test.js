// The join and shutdown flow, run for real against a local mock of the MeetStream API.
// No network, no key: the client is pointed at the mock with MEETSTREAM_BASE_URL.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/session.js';
import { startMock } from './mock.js';

const AGENT_ID = 'agent-111';
const BOT_ID = 'bot-222';
const GROK_AGENT = { Mode: 'realtime', Model: { provider: 'xai', voice: 'Ara' }, Agent: { response_modality: 'audio' } };

let mock;
let calls;
let overrides;
let statuses;

/** Default MeetStream behaviour; a test replaces one route through `overrides["METHOD /path"]`. */
function defaultResponse(call) {
  const { method, path } = call;
  if (method === 'POST' && path === '/mia') return [201, { agent_config_id: AGENT_ID }];
  if (method === 'GET' && path === '/mia') return [200, { agent_config: GROK_AGENT }];
  if (method === 'DELETE' && path === '/mia') return [200, { message: 'deleted' }];
  if (method === 'POST' && path === '/bots/create_bot') {
    return [200, { bot_id: BOT_ID, meeting_url: call.body.meeting_link, transcript_id: 'tr-1' }];
  }
  if (method === 'GET' && path === `/bots/${BOT_ID}/detail`) {
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    return status === 'PENDING' ? [202, {}] : [200, { bot_details: { Status: status } }];
  }
  if (method === 'GET' && path === `/bots/${BOT_ID}/remove_bot`) return [200, {}];
  return [404, { message: 'unexpected route' }];
}

beforeEach(async () => {
  statuses = ['Joining', 'InMeeting'];
  mock = await startMock(defaultResponse);
  calls = mock.calls;
  overrides = mock.overrides;
});

afterEach(async () => {
  await mock.close();
});

function newSession(extra = {}) {
  const out = { log: [], warn: [], error: [] };
  const session = createSession(
    {
      apiKey: 'test-key',
      meetingLink: 'https://meet.google.com/abc-defg-hij',
      existingAgentConfigId: '',
      botName: 'Grok',
      callbackUrl: '',
      deleteAgentOnExit: false,
      pollIntervalMs: 10,
      ...extra
    },
    { log: (m) => out.log.push(m), warn: (m) => out.warn.push(m), error: (m) => out.error.push(m) }
  );
  return { session, out };
}

const routes = () => calls.map((c) => `${c.method} ${c.path}`);
const text = (lines) => lines.join('\n');

/** Wait until the log shows `needle`, so a test can call stop() while the bot is in the call. */
async function until(out, needle) {
  for (let i = 0; i < 300; i += 1) {
    if (text(out.log).includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`never saw "${needle}" in the log:\n${text(out.log)}`);
}

test('join: creates the Grok agent, sends the bot with the agent attached, follows status to the end', async () => {
  statuses = ['Joining', 'InMeeting', 'Stopped'];
  const { session, out } = newSession();
  await session.run();

  assert.deepEqual(routes().slice(0, 2), ['POST /mia', 'POST /bots/create_bot']);

  const agentCall = calls[0];
  assert.equal(agentCall.headers.authorization, 'Token test-key');
  assert.equal(agentCall.body.mode, 'realtime');
  assert.equal(agentCall.body.model.provider, 'xai');

  const botCall = calls[1];
  assert.deepEqual(botCall.body, {
    meeting_link: 'https://meet.google.com/abc-defg-hij',
    bot_name: 'Grok',
    video_required: false,
    agent_config_id: AGENT_ID
  });
  assert.ok(botCall.headers['idempotency-key'], 'create_bot carries an Idempotency-Key');

  const log = text(out.log);
  assert.match(log, /Created Grok agent agent-111/);
  assert.match(log, /Bot bot-222 is joining https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(log, /status: Joining/);
  assert.match(log, /status: InMeeting/);
  assert.match(log, /status: Stopped/);
  assert.match(log, /Session finished with status Stopped/);
  assert.equal(session.state.failed, false);
});

test('join: a bot that ends on its own is not removed again', async () => {
  statuses = ['InMeeting', 'Done'];
  const { session } = newSession();
  await session.run();
  assert.equal(routes().includes(`GET /bots/${BOT_ID}/remove_bot`), false);
});

test('join: callback_url is sent only when configured', async () => {
  statuses = ['Done'];
  const { session } = newSession({ callbackUrl: 'https://example.com/hook' });
  await session.run();
  assert.equal(calls.find((c) => c.path === '/bots/create_bot').body.callback_url, 'https://example.com/hook');
});

test('join: a saved Grok agent is reused, not recreated', async () => {
  statuses = ['Done'];
  const { session, out } = newSession({ existingAgentConfigId: AGENT_ID });
  await session.run();

  assert.equal(routes().includes('POST /mia'), false);
  assert.equal(calls[0].query.agent_config_id, AGENT_ID);
  assert.equal(calls.find((c) => c.path === '/bots/create_bot').body.agent_config_id, AGENT_ID);
  assert.match(text(out.log), /Reusing saved Grok agent agent-111/);
});

test('join: a saved agent that is not Grok stops the run before any bot is sent', async () => {
  overrides['GET /mia'] = () => [200, { agent_config: { Mode: 'realtime', Model: { provider: 'openai' } } }];
  const { session, out } = newSession({ existingAgentConfigId: 'other-agent' });
  await session.run();

  assert.equal(routes().includes('POST /bots/create_bot'), false);
  assert.match(text(out.error), /not Grok/);
  assert.equal(session.state.failed, true);
});

test('join: a rejected create_bot is reported and leaves nothing to remove', async () => {
  overrides['POST /bots/create_bot'] = () => [400, { message: 'invalid meeting link' }];
  const { session, out } = newSession();
  await session.run();

  assert.match(text(out.error), /rejected the request body\. invalid meeting link/);
  assert.equal(session.state.failed, true);
  assert.equal(routes().some((r) => r.endsWith('/remove_bot')), false);
});

test('join: a rejected create_bot deletes the agent it just made when asked to', async () => {
  overrides['POST /bots/create_bot'] = () => [400, { message: 'nope' }];
  const { session } = newSession({ deleteAgentOnExit: true });
  await session.run();

  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'agent was deleted');
  assert.equal(del.query.agent_config_id, AGENT_ID);
});

test('join: a bad API key surfaces as an error, not a crash', async () => {
  overrides['POST /mia'] = () => [403, { message: 'Forbidden' }];
  const { session, out } = newSession();
  await session.run();

  assert.match(text(out.error), /denied the API key/);
  assert.equal(session.state.failed, true);
  assert.equal(routes().includes('POST /bots/create_bot'), false);
});

test('status: a 202 while MeetStream assembles the record is skipped, not treated as a status', async () => {
  statuses = ['PENDING', 'InMeeting', 'Done'];
  const { session, out } = newSession();
  await session.run();

  const log = text(out.log);
  assert.match(log, /status: InMeeting/);
  assert.doesNotMatch(log, /status: PENDING/);
});

test('shutdown: stop() while the bot is in the call removes the bot and ends the run', async () => {
  statuses = ['InMeeting'];
  const { session, out } = newSession();
  const running = session.run();
  await until(out, 'status: InMeeting');

  await session.stop();
  await running;

  assert.equal(routes().filter((r) => r === `GET /bots/${BOT_ID}/remove_bot`).length, 1);
  assert.match(text(out.log), /Stopping\.\.\./);
  assert.match(text(out.log), /Asked MeetStream to remove the bot/);
  assert.doesNotMatch(text(out.log), /Session finished/);
  assert.equal(session.state.failed, false);
  assert.equal(session.state.botId, null);
});

test('shutdown: the saved agent is kept unless DELETE_AGENT_ON_EXIT is set', async () => {
  statuses = ['InMeeting'];
  const { session, out } = newSession();
  const running = session.run();
  await until(out, 'status: InMeeting');
  await session.stop();
  await running;

  assert.equal(calls.some((c) => c.method === 'DELETE'), false);
});

test('shutdown: DELETE_AGENT_ON_EXIT removes the bot first, then the agent', async () => {
  statuses = ['InMeeting'];
  const { session, out } = newSession({ deleteAgentOnExit: true });
  const running = session.run();
  await until(out, 'status: InMeeting');
  await session.stop();
  await running;

  const tail = routes().slice(-2);
  assert.deepEqual(tail, [`GET /bots/${BOT_ID}/remove_bot`, 'DELETE /mia']);
  assert.match(text(out.log), new RegExp(`Deleted agent ${AGENT_ID}`));
});

test('shutdown: stop() during agent creation never sends a bot', async () => {
  overrides['POST /mia'] = () => [201, { agent_config_id: AGENT_ID }, 80];
  const { session } = newSession();
  const running = session.run();
  await session.stop();
  await running;

  assert.equal(routes().includes('POST /bots/create_bot'), false);
  assert.equal(routes().some((r) => r.endsWith('/remove_bot')), false);
});

test('shutdown: stop() is idempotent, so Ctrl+C twice removes the bot once', async () => {
  statuses = ['InMeeting'];
  const { session, out } = newSession();
  const running = session.run();
  await until(out, 'status: InMeeting');

  await Promise.all([session.stop(), session.stop()]);
  await running;

  assert.equal(routes().filter((r) => r.endsWith('/remove_bot')).length, 1);
});

test('shutdown: a failed remove_bot is reported loudly and still deletes the agent', async () => {
  statuses = ['InMeeting'];
  overrides[`GET /bots/${BOT_ID}/remove_bot`] = () => [500, { message: 'boom' }];
  const { session, out } = newSession({ deleteAgentOnExit: true });
  const running = session.run();
  await until(out, 'status: InMeeting');
  await session.stop();
  await running;

  assert.match(text(out.error), /Could not remove bot bot-222/);
  assert.equal(session.state.failed, true);
  assert.ok(calls.some((c) => c.method === 'DELETE'), 'agent still deleted');
});

test('shutdown: a 404 from remove_bot means the bot is already gone, which is success', async () => {
  statuses = ['InMeeting'];
  overrides[`GET /bots/${BOT_ID}/remove_bot`] = () => [404, { message: 'not found' }];
  const { session, out } = newSession();
  const running = session.run();
  await until(out, 'status: InMeeting');
  await session.stop();
  await running;

  assert.equal(session.state.failed, false);
  assert.deepEqual(out.error, []);
});

test('join: TRANSCRIBE adds a post-call transcript request to create_bot, and is absent otherwise', async () => {
  statuses = ['Done'];
  await newSession().session.run();
  assert.equal(calls.find((c) => c.path === '/bots/create_bot').body.recording_config, undefined);

  calls.length = 0;
  statuses = ['Done'];
  await newSession({ transcribe: true }).session.run();
  const body = calls.find((c) => c.path === '/bots/create_bot').body;
  assert.deepEqual(Object.keys(body.recording_config.transcript.provider), ['deepgram']);
  assert.equal(body.video_required, false);
});
