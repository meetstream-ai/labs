import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
test('task receipts and approval requirements survive reopening the on-disk ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-ledger-'));
  const path = join(dir, 'bridge.sqlite');
  let store = new Store(path);
  try {
    const b = new Bridge(store, { run: () => assert.fail('unapproved work must not run') });
    const s = b.create({ repo: '/tmp/repo' });
    const req = { requestId: 'stable', text: 'fix issue', kind: 'engineering' };
    const task = b.submit(s.id, req);
    store.close();
    store = new Store(path);
    const restarted = new Bridge(store, { run: () => assert.fail('receipt replay must not run') });
    assert.equal(restarted.submit(s.id, req).id, task.id);
    assert.equal(restarted.task(s.id, task.id).status, 'awaiting_approval');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('queue reads preserve admission order rather than UUID sort order', () => {
  const store = new Store(':memory:');
  try {
    store.put('task', 'z', { id: 'z' });
    store.put('task', 'a', { id: 'a' });
    assert.deepEqual(
      store.all('task').map((x) => x.id),
      ['z', 'a'],
    );
  } finally {
    store.close();
  }
});

test('native owner lock excludes another process and recovers after a crash', async (t) => {
  const { acquireOwner } = await import('../src/store.js');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-owner-'));
  const path = join(dir, 'owner.sqlite');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {acquireOwner} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};acquireOwner(${JSON.stringify(path)});console.log('READY');setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  await once(child.stdout, 'data');
  assert.throws(() => acquireOwner(path), /Another bridge/);
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  const owner = acquireOwner(path);
  owner.close();
});
