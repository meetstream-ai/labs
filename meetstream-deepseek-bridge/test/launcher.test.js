import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireOwner } from '../src/store.js';
test('launcher creates owned resources; npm-stop route removes bot, then config, then exits', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-launcher-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const bin = join(dir, 'dsh');
  writeFileSync(
    bin,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('0.2.1-rc.5'); else console.log(JSON.stringify({type:'final',text:'HARNESS_OK'}));",
    { mode: 0o700 },
  );
  const requests = [];
  let departed = false;
  const api = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    requests.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/mia' && req.method === 'POST')
      res.end(JSON.stringify({ agent_config_id: 'owned-agent' }));
    else if (req.url === '/api/v1/bots/create_bot')
      res.end(JSON.stringify({ bot_id: 'owned-bot' }));
    else if (req.url === '/api/v1/bots/owned-bot/remove_bot') {
      departed = true;
      res.end('{}');
    } else if (req.url === '/api/v1/bots/owned-bot/status')
      res.end(JSON.stringify({ status: departed ? 'Done' : 'InMeeting' }));
    else if (req.url === '/api/v1/mia?agent_config_id=owned-agent' && req.method === 'DELETE')
      res.end('{}');
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'start'], {
    env: {
      ...process.env,
      DSH_BIN: bin,
      DEEPSEEK_API_KEY: 'sk-fixture',
      DSH_ACCOUNT: 'false',
      DSH_LOCAL_OLLAMA: 'false',
      BRIDGE_STATE_DIR: join(dir, 'state'),
      PORT: '0',
      REPO_PATH: repo,
      MEETING_URL: 'https://meet.google.com/abc-defg-hij',
      PUBLIC_URL: 'https://bridge.example.com',
      MEETSTREAM_API_KEY: 'test-key',
      MEETSTREAM_BASE_URL: `http://127.0.0.1:${api.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  t.after(async () => {
    child.kill();
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('Admit DeepSeek')) {
    if (Date.now() > deadline) assert.fail(output);
    await new Promise((r) => setTimeout(r, 20));
  }
  const active = JSON.parse(readFileSync(join(dir, 'state', 'active.json')));
  assert.notEqual(active.adminToken, 'test-key');
  const stopper = spawn(process.execPath, [resolve('src/cli.js'), 'stop'], {
    env: { ...process.env, BRIDGE_STATE_DIR: join(dir, 'state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stopOutput = '';
  stopper.stdout.on('data', (b) => (stopOutput += b));
  stopper.stderr.on('data', (b) => (stopOutput += b));
  const [stopCode] = await once(stopper, 'close');
  assert.equal(stopCode, 0, stopOutput);
  // A successful stop must be immediately safe to restart.
  const released = acquireOwner(join(dir, 'state', 'owner.sqlite'));
  released.close();
  await closed;
  assert.ok(!existsSync(join(dir, 'state', 'lock')));
  const removal = requests.findIndex((x) => x.url.endsWith('/remove_bot'));
  const deletion = requests.findIndex((x) => x.method === 'DELETE');
  assert.ok(removal >= 0 && deletion > removal);
  const create = requests.find((x) => x.url.endsWith('/create_bot'));
  assert.equal(create.body.agent_config_id, 'owned-agent');
  assert.equal(create.body.socket_connection_url, undefined);
  assert.equal(create.body.live_audio_required, undefined);
  const transcription = create.body.recording_config.transcript.provider.deepgram_streaming;
  assert.equal(transcription.model, 'nova-2');
  assert.equal(transcription.encoding, 'linear16');
  assert.equal(transcription.channels, 1);
  assert.match(
    create.body.live_transcription_required.webhook_url,
    /^https:\/\/bridge\.example\.com\/transcript\//,
  );
});

test('shutdown during registration waits for the returned owned ID before cleanup', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-launch-cancel-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const bin = join(dir, 'dsh');
  writeFileSync(
    bin,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('0.2.1-rc.5'); else console.log(JSON.stringify({type:'final',text:'HARNESS_OK'}));",
    { mode: 0o700 },
  );
  let release, sawRegistration;
  const registering = new Promise((r) => {
    sawRegistration = r;
  });
  const urls = [];
  const api = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    urls.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/mia') {
      release = () => res.end('{"agent_config_id":"late-owned-agent"}');
      sawRegistration();
    } else if (req.method === 'DELETE') res.end('{}');
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'start'], {
    env: {
      ...process.env,
      DSH_BIN: bin,
      DEEPSEEK_API_KEY: 'sk-fixture',
      DSH_ACCOUNT: 'false',
      DSH_LOCAL_OLLAMA: 'false',
      BRIDGE_STATE_DIR: join(dir, 'state'),
      PORT: '0',
      REPO_PATH: repo,
      MEETING_URL: 'https://meet.google.com/abc-defg-hij',
      PUBLIC_URL: 'https://bridge.example.com',
      MEETSTREAM_API_KEY: 'test-key',
      MEETSTREAM_BASE_URL: `http://127.0.0.1:${api.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    api.closeAllConnections();
    await new Promise((r) => api.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  await registering;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 30));
  release();
  await closed;
  assert.ok(urls.includes('/api/v1/mia?agent_config_id=late-owned-agent'));
  assert.ok(!urls.includes('/api/v1/bots/create_bot'));
});

test('an API-credit launch without a key fails before creating meeting resources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meetstream-no-key-'));
  const bin = join(dir, 'dsh');
  writeFileSync(
    bin,
    "#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('0.2.1-rc.5'); else console.log(JSON.stringify({type:'final',text:'HARNESS_OK'}));",
    { mode: 0o700 },
  );
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [resolve('src/cli.js'), 'start'], {
          env: {
            ...process.env,
            DSH_BIN: bin,
            BRIDGE_STATE_DIR: join(dir, 'state'),
            DEEPSEEK_API_KEY: '',
            DSH_ACCOUNT: 'false',
            DSH_LOCAL_OLLAMA: 'false',
          },
          stdio: 'pipe',
        }),
      (e) => {
        assert.match(e.stderr.toString(), /DEEPSEEK_API_KEY/);
        assert.equal(
          JSON.parse(readFileSync(join(dir, 'state', 'active.json'))).sessionId,
          undefined,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
