import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
const tick = () => new Promise((r) => setImmediate(r));
function setup(run = async () => 'answer') {
  const store = new Store(':memory:');
  let calls = 0;
  const bridge = new Bridge(store, {
    run: async (opts) => {
      calls++;
      return run(opts);
    },
  });
  const s = bridge.create({
    repo: '/tmp/repo',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
  });
  return { store, bridge, s, calls: () => calls };
}
test('engineering needs exact operator approval, duplicate approvals execute once', async () => {
  const x = setup();
  const t = x.bridge.submit(x.s.id, { requestId: 'r1', text: 'fix bug', kind: 'engineering' });
  assert.equal(t.status, 'awaiting_approval');
  await tick();
  assert.equal(x.calls(), 0);
  x.bridge.approve(x.s.id, t.id);
  x.bridge.approve(x.s.id, t.id);
  await tick();
  assert.equal(x.calls(), 1);
  assert.equal(x.bridge.task(x.s.id, t.id).status, 'completed');
  x.store.close();
});
test('duplicate concurrent request receipts do not execute twice', async () => {
  const x = setup();
  const req = { requestId: 'r', text: 'where is parser?' };
  const a = x.bridge.submit(x.s.id, req),
    b = x.bridge.submit(x.s.id, req);
  assert.equal(a.id, b.id);
  await tick();
  assert.equal(x.calls(), 1);
  assert.throws(() => x.bridge.submit(x.s.id, { ...req, text: 'other' }), /conflict/);
  x.store.close();
});
test('context is speaker labelled, final only, deduplicated and bounded', () => {
  const x = setup();
  x.bridge.context(x.s.id, { id: 'partial', speaker: 'Alice', text: 'hello', final: false });
  for (let i = 0; i < 45; i++)
    x.bridge.context(x.s.id, { id: String(i), speaker: 'Alice', text: 'hello', final: true });
  x.bridge.context(x.s.id, { id: '44', speaker: 'Alice', text: 'hello', final: true });
  const s = x.bridge.session(x.s.id);
  assert.equal(s.context.length, 40);
  assert.equal(s.context[0].id, '5');
  assert.equal(s.context[0].speaker, 'Alice');
  x.store.close();
});
test('one process per meeting; queue drains in order', async () => {
  let release;
  const x = setup(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const a = x.bridge.submit(x.s.id, { requestId: '1', text: 'one' });
  const b = x.bridge.submit(x.s.id, { requestId: '2', text: 'two' });
  await tick();
  assert.equal(x.calls(), 1);
  assert.equal(x.bridge.task(x.s.id, b.id).status, 'queued');
  release('one');
  await tick();
  assert.equal(x.calls(), 2);
  release('two');
  await tick();
  assert.equal(x.bridge.task(x.s.id, a.id).status, 'completed');
  x.store.close();
});
test('cancel waits for runtime abort and suppresses stale completion', async () => {
  const x = setup(
    ({ signal }) =>
      new Promise((r) => signal.addEventListener('abort', () => r('stale'), { once: true })),
  );
  const t = x.bridge.submit(x.s.id, { requestId: '1', text: 'one' });
  await tick();
  await x.bridge.cancel(x.s.id, t.id);
  assert.equal(x.bridge.task(x.s.id, t.id).status, 'cancelled');
  assert.equal(x.bridge.task(x.s.id, t.id).result, undefined);
  x.store.close();
});
test('session end cancels running and queued work, rejects followups', async () => {
  const x = setup(
    ({ signal }) =>
      new Promise((r) => signal.addEventListener('abort', () => r('stale'), { once: true })),
  );
  const a = x.bridge.submit(x.s.id, { requestId: '1', text: 'one' });
  const b = x.bridge.submit(x.s.id, { requestId: '2', text: 'two' });
  await tick();
  await x.bridge.close(x.s.id);
  assert.equal(x.bridge.task(x.s.id, a.id).status, 'cancelled');
  assert.equal(x.bridge.task(x.s.id, b.id).status, 'cancelled');
  assert.throws(() => x.bridge.submit(x.s.id, { requestId: '3', text: 'three' }), /closed/);
  x.store.close();
});
test('crash recovery fences uncertain work without replay', () => {
  const x = setup();
  x.store.put('task', 'uncertain', { id: 'uncertain', sessionId: x.s.id, status: 'running' });
  const restarted = new Bridge(x.store, { run: () => assert.fail('must not replay') });
  assert.equal(restarted.task(x.s.id, 'uncertain').status, 'interrupted');
  x.store.close();
});
test('task references cannot cross meetings', () => {
  const x = setup();
  const t = x.bridge.submit(x.s.id, { requestId: '1', text: 'fix', kind: 'engineering' });
  const other = x.bridge.create({ repo: '/tmp/other' });
  assert.throws(() => x.bridge.task(other.id, t.id), /Unknown/);
  x.store.close();
});
test('runtime failures become durable failed state', async () => {
  const x = setup(async () => {
    throw new Error('provider unavailable');
  });
  const t = x.bridge.submit(x.s.id, { requestId: 'r', text: 'question' });
  await tick();
  assert.equal(x.bridge.task(x.s.id, t.id).status, 'failed');
  assert.match(x.bridge.task(x.s.id, t.id).error, /unavailable/);
  x.store.close();
});
test('separate permission lanes retain separate Harness session IDs', async () => {
  const modes = [];
  const x = setup(async (o) => {
    modes.push([o.mode, o.sessionId]);
    o.onSession('session-' + o.mode);
    return 'ok';
  });
  x.bridge.submit(x.s.id, { requestId: 'q', text: 'question' });
  await tick();
  const t = x.bridge.submit(x.s.id, { requestId: 'w', text: 'fix', kind: 'engineering' });
  x.bridge.approve(x.s.id, t.id);
  await tick();
  x.bridge.submit(x.s.id, { requestId: 'q2', text: 'followup' });
  await tick();
  assert.deepEqual(modes, [
    ['read-only', undefined],
    ['workspace-write', undefined],
    ['read-only', 'session-read-only'],
  ]);
  x.store.close();
});

test('tool progress is durable and notifications are bounded', async () => {
  const messages = [];
  const x = setup(async (opts) => {
    for (let i = 0; i < 5; i++) opts.onProgress('tool_call');
    return 'done';
  });
  x.bridge.notify = async (s, m) => messages.push(m);
  const t = x.bridge.submit(x.s.id, { requestId: 'progress', text: 'inspect repo' });
  await tick();
  assert.equal(x.bridge.task(x.s.id, t.id).progress.events, 5);
  assert.equal(messages.filter((m) => m.includes('in progress')).length, 1);
  x.store.close();
});

test('repeated cancellation waits for actual runtime shutdown', async () => {
  let release;
  const x = setup(() => new Promise((r) => (release = r)));
  const t = x.bridge.submit(x.s.id, { requestId: 'slow', text: 'slow' });
  await tick();
  const first = x.bridge.cancel(x.s.id, t.id);
  let secondReturned = false;
  const second = x.bridge.cancel(x.s.id, t.id).then(() => (secondReturned = true));
  await tick();
  assert.equal(secondReturned, false);
  release('obsolete');
  await Promise.all([first, second]);
  assert.equal(x.bridge.task(x.s.id, t.id).status, 'cancelled');
  x.store.close();
});
test('a failed instruction is not resumed by a later approved task', async () => {
  const ids = [];
  const x = setup(async (o) => {
    ids.push(o.sessionId);
    o.onSession('failed-session');
    if (ids.length === 1) throw new Error('fixture');
    return 'new task';
  });
  const first = x.bridge.submit(x.s.id, { requestId: 'first', text: 'first' });
  await tick();
  assert.equal(x.bridge.task(x.s.id, first.id).status, 'failed');
  x.bridge.submit(x.s.id, { requestId: 'second', text: 'second' });
  await tick();
  assert.deepEqual(ids, [undefined, undefined]);
  x.store.close();
});
test('chat failure does not prevent authorized runtime work', async () => {
  const x = setup();
  x.bridge.notify = async () => {
    throw new Error('chat unavailable');
  };
  const t = x.bridge.submit(x.s.id, { requestId: 'r', text: 'read' });
  await tick();
  assert.equal(x.calls(), 1);
  assert.equal(x.bridge.task(x.s.id, t.id).status, 'completed');
  x.store.close();
});
test('meetings sharing one repository cannot execute concurrently', async () => {
  let release;
  const x = setup(() => new Promise((r) => (release = r)));
  const other = x.bridge.create({ repo: x.s.repo });
  const a = x.bridge.submit(x.s.id, { requestId: 'a', text: 'a' });
  const b = x.bridge.submit(other.id, { requestId: 'b', text: 'b' });
  await tick();
  assert.equal(x.calls(), 1);
  assert.equal(x.bridge.task(other.id, b.id).status, 'queued');
  release('a');
  await tick();
  assert.equal(x.calls(), 2);
  release('b');
  await tick();
  assert.equal(x.bridge.task(x.s.id, a.id).status, 'completed');
  x.store.close();
});

test('closing an already cleaned session never reintroduces pending cleanup', async () => {
  const x = setup();
  const s = x.bridge.session(x.s.id);
  s.botId = 'historical-bot';
  s.cleanedAt = Date.now();
  s.cleanupPending = false;
  x.store.put('session', s.id, s);
  await x.bridge.close(s.id);
  assert.equal(x.bridge.session(s.id).cleanupPending, false);
  x.store.close();
});
