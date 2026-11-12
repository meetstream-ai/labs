import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { MeetStream, miaConfig } from '../src/meetstream.js';
test('MIA custom functions never expose operator approval', () => {
  const c = miaConfig('https://example.com', 'token', 'sid');
  assert.equal(c.agent.custom_functions.length, 4);
  assert.ok(c.agent.custom_functions.every((x) => !x.name.includes('approve')));
  assert.equal(c.agent.custom_functions[0].url, 'https://example.com/mia/sid/ask_repository');
});
test('cleanup retains ownership while removal is only accepted', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  const calls = [];
  ms.request = async (path) => {
    calls.push(path);
    return { status: 'InMeeting' };
  };
  const s = { id: 's', botId: 'b', agentId: 'a', cleanupPending: true };
  assert.equal(await ms.cleanup(store, s, { waitMs: 0 }), false);
  assert.equal(s.cleanupPending, true);
  assert.ok(!calls.some((p) => p.startsWith('/mia')));
  store.close();
});
test('cleanup confirms departure before deleting owned MIA config', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  const calls = [];
  ms.request = async (path, method) => {
    calls.push([path, method]);
    return { status: 'Done' };
  };
  const s = { id: 's', botId: 'b', agentId: 'a', cleanupPending: true };
  assert.equal(await ms.cleanup(store, s), true);
  assert.equal(s.cleanupPending, false);
  assert.deepEqual(calls, [
    ['/bots/b/status', undefined],
    ['/mia?agent_config_id=a', 'DELETE'],
  ]);
  store.close();
});
test('ambiguous create cannot be forgotten or recreated automatically', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  ms.request = () => assert.fail('unresolved creation requires reconciliation');
  assert.equal(await ms.cleanup(store, { id: 's', botCreatePending: true }), false);
  store.close();
});

test('a 404 from remove_bot does not prove the still-active bot departed', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  const paths = [];
  ms.request = async (path) => {
    paths.push(path);
    if (path.endsWith('/remove_bot')) {
      const e = new Error('remove unavailable');
      e.status = 404;
      throw e;
    }
    return { status: 'InMeeting' };
  };
  assert.equal(
    await ms.cleanup(store, { id: 's', botId: 'b', agentId: 'a' }, { waitMs: 0 }),
    false,
  );
  assert.equal(paths.filter((p) => p.endsWith('/status')).length, 2);
  assert.ok(!paths.some((p) => p.startsWith('/mia')));
  store.close();
});
test('a lost removal response is reconciled using independent departure status', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  let status = 0;
  ms.request = async (path) => {
    if (path.endsWith('/remove_bot')) throw new Error('network');
    return { status: ++status === 1 ? 'InMeeting' : 'Done' };
  };
  assert.equal(await ms.cleanup(store, { id: 's', botId: 'b' }), true);
  store.close();
});

test('cleanup waits for an accepted departure to become terminal', async () => {
  const store = new Store(':memory:');
  const ms = new MeetStream('key');
  let calls = 0;
  ms.request = async (path) =>
    path.endsWith('/status') ? { status: ++calls < 3 ? 'InMeeting' : 'Done' } : {};
  assert.equal(
    await ms.cleanup(store, { id: 's', botId: 'b', agentId: 'a' }, { waitMs: 100 }),
    true,
  );
  assert.equal(calls, 3);
  store.close();
});
