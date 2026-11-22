import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/harness.js';
function fixture(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-dsh-test-'));
  const bin = join(dir, 'dsh');
  writeFileSync(bin, '#!/usr/bin/env node\n' + script, { mode: 0o700 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { repo: dir, h: new Harness(bin, 2000) };
}
test('pinned version check rejects incompatible runtime', (t) => {
  const { h } = fixture(t, "console.log('0.1.0')");
  assert.throws(() => h.check(), /required/);
});
test('pinned final event shape, stdin and session adoption', async (t) => {
  const { h, repo } = fixture(
    t,
    `let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify({type:'session',sessionId:'session-one'}));console.log(JSON.stringify({type:'final',text}));`,
  );
  let id;
  assert.equal(
    await h.run({
      repo,
      mode: 'read-only',
      prompt: '--dangerous $(echo data)',
      onSession: (x) => (id = x),
    }),
    '--dangerous $(echo data)',
  );
  assert.equal(id, 'session-one');
});
test('nonzero exit cannot masquerade as successful final', async (t) => {
  const { h, repo } = fixture(
    t,
    `console.log(JSON.stringify({type:'final',text:'fake'}));process.exitCode=1;`,
  );
  await assert.rejects(h.run({ repo, mode: 'read-only', prompt: 'hi' }), /failed/);
});
test('malformed protocol fails closed', async (t) => {
  const { h, repo } = fixture(t, `console.log('bad-json');setInterval(()=>{},1000);`);
  await assert.rejects(h.run({ repo, mode: 'read-only', prompt: 'hi' }), /cancelled|Invalid/);
});
test('cancel terminates the process before returning', async (t) => {
  const { h, repo } = fixture(t, `setInterval(()=>{},1000);`);
  const c = new AbortController();
  const result = h.run({ repo, mode: 'read-only', prompt: 'hi', signal: c.signal });
  setTimeout(() => c.abort(), 30);
  await assert.rejects(result, /cancelled/);
});
test('runtime cannot inherit MeetStream or GitHub API tokens', async (t) => {
  const { h, repo } = fixture(
    t,
    `console.log(JSON.stringify({type:'final',text:JSON.stringify([process.env.MEETSTREAM_API_KEY,process.env.GH_TOKEN])}));`,
  );
  process.env.MEETSTREAM_API_KEY = 'test-secret';
  process.env.GH_TOKEN = 'test-secret';
  try {
    assert.equal(await h.run({ repo, mode: 'read-only', prompt: 'hi' }), '[null,null]');
  } finally {
    delete process.env.MEETSTREAM_API_KEY;
    delete process.env.GH_TOKEN;
  }
});

test('invalid deadlines fail early rather than becoming one-millisecond tasks', () => {
  for (const n of [NaN, Infinity, 0, -1, 2147483648])
    assert.throws(() => new Harness('dsh', n), /TASK_TIMEOUT_MS/);
});
test('a failed durable terminal cannot masquerade as success with exit zero', async (t) => {
  const { h, repo } = fixture(
    t,
    `console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'error',error:{code:'QUOTA'}}}));console.log(JSON.stringify({type:'final',text:'not a result'}));`,
  );
  await assert.rejects(h.run({ repo, mode: 'read-only', prompt: 'hi' }), /QUOTA/);
});
test('pre-aborted tasks never spawn the runtime', async (t) => {
  const { h, repo } = fixture(t, `process.exit(0)`);
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    h.run({ repo, mode: 'read-only', prompt: 'hi', signal: c.signal }),
    /cancelled/,
  );
});

test('killing the bridge parent terminates its supervised runtime', async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { readFileSync, existsSync } = await import('node:fs');
  const { h, repo } = fixture(
    t,
    `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('heartbeat','x'),20);`,
  );
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {Harness} from ${JSON.stringify(new URL('../src/harness.js', import.meta.url).href)};await new Harness(${JSON.stringify(h.bin)},10000).run({repo:${JSON.stringify(repo)},mode:'read-only',prompt:'wait'});`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => parent.kill('SIGKILL'));
  const path = join(repo, 'heartbeat');
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 20));
  }
  const closed = once(parent, 'close');
  parent.kill('SIGKILL');
  await closed;
  await new Promise((r) => setTimeout(r, 100));
  const before = readFileSync(path, 'utf8');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(path, 'utf8'), before);
});
test('auth preflight rejects missing keys and conflicting provider modes', () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_ACCOUNT = 'false';
    process.env.DSH_LOCAL_OLLAMA = 'false';
    process.env.DEEPSEEK_API_KEY = '';
    const h = new Harness();
    assert.throws(() => h.validateAuth(), /DEEPSEEK_API_KEY/);
    process.env.DEEPSEEK_API_KEY = 'fixture';
    assert.equal(h.validateAuth(), 'api-key');
    process.env.DSH_ACCOUNT = 'true';
    process.env.DSH_LOCAL_OLLAMA = 'true';
    assert.throws(() => h.validateAuth(), /Choose either/);
  } finally {
    for (const k of ['DSH_ACCOUNT', 'DSH_LOCAL_OLLAMA', 'DEEPSEEK_API_KEY'])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
});

test('unterminated output is bounded before a newline arrives', async (t) => {
  const { h, repo } = fixture(
    t,
    `process.stdout.write('x'.repeat(18*1024*1024));setInterval(()=>{},1000);`,
  );
  await assert.rejects(h.run({ repo, mode: 'read-only', prompt: 'hi' }), /output limit exceeded/);
});
