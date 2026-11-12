import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Launcher did not reach the expected state');
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function fixture(t, { waiting = false, cleanupDelay = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-guided-'));
  const repo = join(dir, 'repo'),
    state = join(dir, 'state');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const runtime = join(dir, 'runtime.json'),
    tunnelPid = join(dir, 'tunnel.json');
  const bin = join(dir, 'dsh'),
    ngrok = join(dir, 'ngrok');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from 'node:fs';
if(process.argv.includes('--version')) { console.log('0.2.1-rc.5'); process.exit(); }
let text='';for await(const part of process.stdin) text+=part;
if(text.includes('HARNESS_OK') && ${!waiting}) console.log(JSON.stringify({type:'final',text:'HARNESS_OK'}));
else { fs.writeFileSync(${JSON.stringify(runtime)}, JSON.stringify({pid:process.pid})); setInterval(()=>{},1000); }
`,
    { mode: 0o700 },
  );
  writeFileSync(
    ngrok,
    `#!/usr/bin/env node
import fs from 'node:fs';
if(process.env.DEEPSEEK_API_KEY || process.env.MEETSTREAM_API_KEY) process.exit(4);
fs.writeFileSync(${JSON.stringify(tunnelPid)},JSON.stringify({pid:process.pid}));
console.log(JSON.stringify({msg:'started tunnel',url:'https://bridge.example.com'}));
setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(dir, 'lose-tunnel'))}))process.exit(1)},25);
`,
    { mode: 0o700 },
  );
  let mia,
    departed = false;
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push([req.url, req.method]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/mia' && req.method === 'POST') {
      mia = JSON.parse(raw);
      res.end('{"agent_config_id":"owned-agent"}');
    } else if (req.url.endsWith('/create_bot')) res.end('{"bot_id":"owned-bot"}');
    else if (req.url.endsWith('/remove_bot')) {
      await new Promise((r) => setTimeout(r, cleanupDelay));
      departed = true;
      res.end('{}');
    } else if (req.url.endsWith('/status'))
      res.end(JSON.stringify({ status: departed ? 'Done' : 'InMeeting' }));
    else res.end('{}');
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const env = {
    ...process.env,
    DSH_BIN: bin,
    NGROK_BIN: ngrok,
    NGROK_AUTHTOKEN: 'fixture',
    DEEPSEEK_API_KEY: 'fixture',
    DSH_ACCOUNT: 'false',
    DSH_LOCAL_OLLAMA: 'false',
    MEETSTREAM_API_KEY: 'fixture',
    MEETSTREAM_BASE_URL: `http://127.0.0.1:${api.address().port}`,
    PUBLIC_URL: '',
    BRIDGE_STATE_DIR: state,
    PORT: '0',
    REPO_PATH: repo,
    MEETING_URL: 'https://meet.google.com/abc-defg-hij',
  };
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'start'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    output += b;
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const stop = async () => {
    const p = spawn(process.execPath, [resolve('src/cli.js'), 'stop'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.resume();
    p.stderr.resume();
    assert.equal((await once(p, 'close'))[0], 0);
  };
  const approve = async () => {
    const a = JSON.parse(readFileSync(join(state, 'active.json')));
    const post = async (path, body, authorization) => {
      const r = await fetch(`http://127.0.0.1:${a.port}` + path, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const task = await post(
      `/mia/${a.sessionId}/propose_task`,
      {
        name: 'propose_task',
        bot: { bot_id: 'owned-bot' },
        args: { request_id: 'long-task', text: 'Run a long controlled test.' },
      },
      mia.agent.custom_functions[0].headers.Authorization,
    );
    await post(
      '/admin/approve',
      { session_id: a.sessionId, task_id: task.task_id },
      'Bearer ' + a.adminToken,
    );
  };
  return {
    dir,
    state,
    runtime,
    tunnelPid,
    child,
    closed,
    requests,
    stop,
    approve,
    output: () => output,
  };
}
for (const method of ['npm stop', 'Ctrl+C', 'repeated Ctrl+C'])
  test(`${method} stops active runtime, owned tunnel and bot`, async (t) => {
    const x = await fixture(t, { cleanupDelay: method === 'repeated Ctrl+C' ? 200 : 0 });
    await until(() => x.output().includes('Admit DeepSeek'));
    await x.approve();
    await until(() => existsSync(x.runtime));
    if (method === 'npm stop') await x.stop();
    else {
      x.child.kill('SIGINT');
      if (method === 'repeated Ctrl+C') {
        await until(() => x.requests.some(([path]) => path.endsWith('/remove_bot')));
        x.child.kill('SIGINT');
      }
    }
    assert.equal((await x.closed)[0], 0, x.output());
    for (const file of [x.runtime, x.tunnelPid])
      assert.throws(() => process.kill(JSON.parse(readFileSync(file)).pid, 0), { code: 'ESRCH' });
    const store = new Store(join(x.state, 'bridge.sqlite'));
    assert.equal(store.all('task')[0].status, 'cancelled');
    assert.ok(store.all('session')[0].cleanedAt);
    store.close();
    const leave = x.requests.findIndex(([path]) => path.endsWith('/remove_bot'));
    assert.ok(leave >= 0 && x.requests.findIndex(([, method]) => method === 'DELETE') > leave);
  });
test('npm stop cancels a startup inference check before inviting any bot', async (t) => {
  const x = await fixture(t, { waiting: true });
  await until(() => existsSync(x.runtime));
  await x.stop();
  assert.equal((await x.closed)[0], 0, x.output());
  assert.deepEqual(x.requests, []);
  assert.equal(existsSync(x.tunnelPid), false);
  assert.throws(() => process.kill(JSON.parse(readFileSync(x.runtime)).pid, 0), { code: 'ESRCH' });
});
test('a lost managed tunnel stops the bridge and cleans its cloud resources', async (t) => {
  const x = await fixture(t);
  await until(() => x.output().includes('Admit DeepSeek'));
  writeFileSync(join(x.dir, 'lose-tunnel'), 'stop');
  assert.equal((await x.closed)[0], 1, x.output());
  assert.ok(x.requests.some(([, method]) => method === 'DELETE'));
});
test('stop before the first start succeeds without installed project dependencies', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-fresh-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = spawn(process.execPath, [resolve('src/cli.js'), 'stop'], {
    env: { ...process.env, BRIDGE_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.resume();
  p.stderr.resume();
  assert.equal((await once(p, 'close'))[0], 0);
});

test(
  'the CLI runs through a symlinked project entry point',
  { skip: process.platform === 'win32' },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-linked-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const entry = join(dir, 'bridge.js');
    symlinkSync(resolve('src/cli.js'), entry);
    const p = spawn(process.execPath, [entry, 'stop'], {
      env: { ...process.env, BRIDGE_STATE_DIR: join(dir, 'state') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    p.stdout.on('data', (b) => {
      output += b;
    });
    p.stderr.resume();
    assert.equal((await once(p, 'close'))[0], 0);
    assert.match(output, /already stopped/);
  },
);

test('a misspelled startup command cannot create state or invite a bot', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-command-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  const p = spawn(process.execPath, [resolve('src/cli.js'), 'start', 'approev'], {
    env: { ...process.env, BRIDGE_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.resume();
  p.stderr.resume();
  assert.equal((await once(p, 'close'))[0], 1);
  assert.equal(existsSync(state), false);
});
