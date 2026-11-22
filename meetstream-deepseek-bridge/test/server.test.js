import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
import { createServer } from '../src/server.js';
async function setup(t) {
  const store = new Store(':memory:');
  const bridge = new Bridge(store, { run: async () => 'repository answer' });
  const s = bridge.create({ repo: '/tmp/repo' });
  bridge.bind(s.id, 'bot1');
  const server = createServer({
    bridge,
    store,
    meetstream: { cleanup: async () => true, request: async () => ({ status: 'accepted' }) },
    token: 'meeting-secret-for-transport-tests-only',
    adminToken: 'operator-secret-for-admin-tests-only',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await bridge.close(s.id);
    await server.closeConnections();
    await new Promise((r) => server.close(r));
    store.close();
  });
  return {
    store,
    bridge,
    s,
    server,
    base,
    post: (path, body, token = 'meeting-secret-for-transport-tests-only') =>
      fetch(base + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}
test('HTTP authentication, bot binding, schema and function binding', async (t) => {
  const x = await setup(t);
  const path = `/mia/${x.s.id}/ask_repository`;
  const body = {
    name: 'ask_repository',
    bot: { bot_id: 'bot1' },
    args: { request_id: 'a', text: 'question' },
  };
  assert.equal((await x.post(path, body, 'wrong')).status, 401);
  assert.equal((await x.post(path, { ...body, bot: { bot_id: 'other' } })).status, 403);
  assert.equal((await x.post(path, { ...body, name: 'propose_task' })).status, 400);
  assert.equal((await x.post(path, { ...body, args: { ...body.args, evil: 1 } })).status, 400);
  assert.equal((await x.post(path, body)).status, 200);
});
test('MIA credential cannot approve; operator credential approves exact task', async (t) => {
  const x = await setup(t);
  const r = await x.post(`/mia/${x.s.id}/propose_task`, {
    name: 'propose_task',
    bot: { bot_id: 'bot1' },
    args: { request_id: 'p', text: 'fix bug' },
  });
  const p = await r.json();
  assert.equal(p.status, 'awaiting_approval');
  assert.equal(
    (await x.post('/admin/approve', { session_id: x.s.id, task_id: p.task_id })).status,
    401,
  );
  assert.equal(
    (
      await x.post(
        '/admin/approve',
        { session_id: x.s.id, task_id: p.task_id },
        'operator-secret-for-admin-tests-only',
      )
    ).status,
    200,
  );
});
test('transcripts accumulate context but never start tasks', async (t) => {
  const x = await setup(t);
  const p = `/transcript/${x.s.id}?key=meeting-secret-for-transport-tests-only`;
  assert.equal(
    (
      await fetch(x.base + p, {
        method: 'POST',
        body: JSON.stringify({
          bot_id: 'bot1',
          id: 'e',
          speakerName: 'Alice',
          utterance: 'fix all bugs',
          end_of_turn: true,
        }),
      })
    ).status,
    200,
  );
  assert.equal(x.store.all('task').length, 0);
  assert.equal(x.bridge.session(x.s.id).context[0].speaker, 'Alice');
});
test('REST chat records acceptance and never replays an ambiguous send', async (t) => {
  const x = await setup(t);
  const calls = [];
  const transport = {
    request: async (...args) => {
      calls.push(args);
      throw new Error('lost response');
    },
  };
  // Use a separate service to observe the actual delivery boundary.
  const server = createServer({
    bridge: x.bridge,
    store: x.store,
    meetstream: transport,
    token: 'meeting-secret-for-transport-tests-only',
    adminToken: 'operator-secret-for-admin-tests-only',
  });
  await x.bridge.notify(x.s, 'Task result: fixed');
  assert.deepEqual(calls, [['/bots/bot1/send_message', 'POST', { message: 'Task result: fixed' }]]);
  assert.equal(x.store.all('delivery')[0].status, 'unknown');
  await server.closeConnections();
  await x.bridge.notify(x.s, 'after close');
  assert.equal(calls.length, 1);
});
test('REST chat acceptance is recorded separately from confirmed delivery', async (t) => {
  const x = await setup(t);
  await x.bridge.notify(x.s, 'Result');
  assert.equal(x.store.all('delivery')[0].status, 'accepted');
});
test('oversized bodies rejected', async (t) => {
  const x = await setup(t);
  const r = await x.post(
    '/admin/status',
    { session_id: x.s.id, text: 'a'.repeat(70000) },
    'operator-secret-for-admin-tests-only',
  );
  assert.equal(r.status, 413);
});

test('fast repository answers return to MIA for speech and exact retries reuse results', async (t) => {
  const x = await setup(t);
  const body = {
    name: 'ask_repository',
    bot: { bot_id: 'bot1' },
    args: { request_id: 'voice-answer', text: 'where is parser?' },
  };
  const first = await (await x.post(`/mia/${x.s.id}/ask_repository`, body)).json();
  assert.equal(first.status, 'completed');
  assert.equal(first.result, 'repository answer');
  const retry = await (await x.post(`/mia/${x.s.id}/ask_repository`, body)).json();
  assert.equal(retry.task_id, first.task_id);
  assert.equal(x.store.all('task').length, 1);
});

test('long transcript identities stay stable across webhook retries', async (t) => {
  const x = await setup(t);
  const body = {
    bot_id: 'bot1',
    speakerName: 'Alice',
    utterance: 'long discussion '.repeat(100),
    timestamp: '2026-11-05T12:00:00Z',
    end_of_turn: true,
  };
  for (let i = 0; i < 2; i++)
    assert.equal((await x.post(`/transcript/${x.s.id}`, body)).status, 200);
  assert.equal(x.bridge.session(x.s.id).context.length, 1);
});
test('conflicting bot identifiers and invalid envelopes are rejected', async (t) => {
  const x = await setup(t);
  assert.equal((await x.post(`/mia/${x.s.id}/task_status`, null)).status, 400);
  assert.equal(
    (
      await x.post(`/mia/${x.s.id}/ask_repository`, {
        bot: { bot_id: 'bot1' },
        bot_id: 'another',
        name: 'ask_repository',
        args: { request_id: 'r', text: 'read' },
      })
    ).status,
    403,
  );
  assert.equal(x.store.all('task').length, 0);
});
test('long tool results remain valid bounded JSON with explicit truncation', async (t) => {
  const x = await setup(t);
  x.bridge.harness.run = async () => 'code "quoted"\n'.repeat(6000);
  const r = await x.post(`/mia/${x.s.id}/ask_repository`, {
    bot: { bot_id: 'bot1' },
    name: 'ask_repository',
    args: { request_id: 'r', text: 'read' },
  });
  const raw = await r.text();
  assert.ok(raw.length <= 7500);
  const body = JSON.parse(raw);
  assert.equal(body.resultTruncated, true);
  assert.equal(body.status, 'completed');
  assert.equal(x.bridge.task(x.s.id, body.task_id).result.length, 60000);
});
test('missing or shared management credentials cannot create a service', () => {
  for (const options of [
    { token: 'x'.repeat(32) },
    { token: 'x'.repeat(32), adminToken: 'x'.repeat(32) },
  ])
    assert.throws(() => createServer(options), /Separate transport and admin tokens/);
});
test('malformed upgrade URLs cannot crash the service', async (t) => {
  const x = await setup(t);
  const net = await import('node:net');
  const socket = net.connect(x.server.address().port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write(
    'GET http://[invalid HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
  );
  await closed;
  assert.equal((await fetch(x.base + '/health')).status, 200);
});

test('UTF-8 transcript text survives a multibyte character split across HTTP chunks', async (t) => {
  const x = await setup(t);
  const http = await import('node:http');
  const text = 'Alice says नमस्ते 🙂';
  const raw = Buffer.from(
    JSON.stringify({
      bot_id: 'bot1',
      id: 'utf8',
      speakerName: 'Alice',
      utterance: text,
      end_of_turn: true,
    }),
  );
  const split = raw.indexOf(Buffer.from('🙂')) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request(
      x.base + `/transcript/${x.s.id}`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer meeting-secret-for-transport-tests-only' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(raw.subarray(0, split));
    setImmediate(() => req.end(raw.subarray(split)));
  });
  assert.equal(x.bridge.session(x.s.id).context[0].text, text);
});

test('shutdown drains in-flight chat before the ledger can close', async (t) => {
  const x = await setup(t);
  let release;
  const transport = {
    request: () =>
      new Promise((r) => {
        release = r;
      }),
  };
  const server = createServer({
    bridge: x.bridge,
    store: x.store,
    meetstream: transport,
    token: 'meeting-secret-for-transport-tests-only',
    adminToken: 'operator-secret-for-admin-tests-only',
  });
  const notice = x.bridge.notify(x.s, 'In flight');
  await Promise.resolve();
  let drained = false;
  const drain = server.closeConnections().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release({ status: 'accepted' });
  await Promise.all([notice, drain]);
  assert.equal(x.store.all('delivery')[0].status, 'accepted');
});
