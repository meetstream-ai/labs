// Exercise the pinned Harness native DeepSeek Messages route with deterministic API fixtures.
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
import { Store } from '../src/store.js';
import { Bridge } from '../src/bridge.js';
const key = 'sk-loopback-fixture-not-a-real-key';
const repo = mkdtempSync(join(tmpdir(), 'meetstream-api-key-'));
const store = new Store(':memory:');
let scenario = 'success',
  calls = 0,
  toolResults = 0,
  writeIssued = false;
const fixtureErrors = [];
const meetingCalls = [];
let miaConfig,
  departed = false,
  launcher;
const meetingKey = 'meetstream-loopback-fixture-only';
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    if (req.url.startsWith('/api/v1/')) {
      assert.equal(req.headers.authorization, 'Token ' + meetingKey);
      const body = raw ? JSON.parse(raw) : {};
      meetingCalls.push([req.url, req.method, body]);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/mia' && req.method === 'POST') {
        miaConfig = body;
        res.end(JSON.stringify({ agent_config_id: 'fixture-agent' }));
      } else if (req.url === '/api/v1/bots/create_bot') {
        assert.equal(body.agent_config_id, 'fixture-agent');
        assert.equal(body.socket_connection_url, undefined);
        assert.equal(body.recording_config.transcript.provider.deepgram_streaming.model, 'nova-2');
        assert.ok(
          new URL(body.live_transcription_required.webhook_url).pathname.startsWith('/transcript/'),
        );
        res.end(JSON.stringify({ bot_id: 'fixture-bot' }));
      } else if (req.url.endsWith('/remove_bot')) {
        departed = true;
        res.end('{}');
      } else if (req.url.endsWith('/status')) {
        res.end(JSON.stringify({ status: departed ? 'Done' : 'InMeeting' }));
      } else if (req.url.endsWith('/send_message') || req.method === 'DELETE') res.end('{}');
      else {
        res.statusCode = 404;
        res.end('{}');
      }
      return;
    }
    assert.equal(req.url, '/anthropic/v1/messages');
    assert.equal(req.headers['x-api-key'], key);
    assert.equal(req.headers['x-dsh-auth-token'], undefined);
    const body = JSON.parse(raw);
    assert.equal(body.model, 'deepseek-flash');
    calls++;
    if (scenario !== 'success') {
      res.writeHead(scenario === 'unauthorized' ? 401 : 402, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: scenario === 'unauthorized' ? 'authentication_error' : 'insufficient_balance',
            message: scenario,
          },
        }),
      );
      return;
    }
    const messages = JSON.stringify(body.messages);
    const writing = messages.includes('FIX_APPROVED_PARSER');
    const done = body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    if (done) toolResults++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', {
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    });
    const useTool = writing && !writeIssued;
    if (useTool) {
      assert.ok(
        body.tools.some((t) => t.name === 'bash'),
        'tools: ' + JSON.stringify(body.tools.map((t) => t.name)),
      );
      writeIssued = true;
      emit('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_fix', name: 'bash', input: {} },
      });
      const code =
        "export function parseName(text) { return (text.split(',')[1] ?? '').trim(); }\n";
      const command = `printf %s '${Buffer.from(code).toString('base64')}' | base64 --decode > parser.js && node parser.test.js`;
      emit('content_block_delta', {
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            description: 'Fix parser and run regression test',
            command,
          }),
        },
      });
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', {
        index: 0,
        delta: {
          type: 'text_delta',
          text: writing ? 'Parser fixed; PARSER_TESTS_OK.' : 'The parser function is parseName.',
        },
      });
    }
    emit('content_block_stop', { index: 0 });
    emit('message_delta', {
      delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    emit('message_stop', {});
    res.end();
  } catch (e) {
    fixtureErrors.push(e.message);
    console.error('Fixture assertion:', e.message);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    } else res.destroy(e);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
Object.assign(process.env, {
  DEEPSEEK_API_KEY: key,
  DEEPSEEK_MODEL: 'deepseek-flash',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic`,
  DSH_ACCOUNT: 'false',
  DSH_LOCAL_OLLAMA: 'false',
});
const harness = new Harness(process.env.DSH_BIN || undefined, 30000);
harness.check();
const bridge = new Bridge(store, harness);
const s = bridge.create({ repo });
try {
  execFileSync('git', ['init', '-q', repo]);
  const original = "export function parseName(text) { return text.split(',')[1].trim(); }\n";
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  writeFileSync(join(repo, 'parser.js'), original);
  writeFileSync(
    join(repo, 'parser.test.js'),
    "import {parseName} from './parser.js';import assert from 'node:assert/strict';assert.equal(parseName(''),'');assert.equal(parseName('id, Alice'),'Alice');console.log('PARSER_TESTS_OK');",
  );
  for (const requestId of ['q1', 'q2']) {
    const q = bridge.submit(s.id, { requestId, text: 'Name the parser function.' });
    await bridge.running.get(q.id).promise;
    assert.equal(bridge.task(s.id, q.id).status, 'completed', bridge.task(s.id, q.id).error);
    assert.match(bridge.task(s.id, q.id).result, /parseName/);
  }
  assert.ok(bridge.session(s.id)['read-only']);
  const request = {
    requestId: 'fix-1',
    kind: 'engineering',
    text: 'FIX_APPROVED_PARSER: fix empty input and run the regression test.',
  };
  const t = bridge.submit(s.id, request);
  assert.equal(t.status, 'awaiting_approval');
  assert.equal(readFileSync(join(repo, 'parser.js'), 'utf8'), original);
  bridge.approve(s.id, t.id);
  await bridge.running.get(t.id).promise;
  assert.equal(bridge.task(s.id, t.id).status, 'completed', bridge.task(s.id, t.id).error);
  assert.match(
    execFileSync(process.execPath, ['parser.test.js'], { cwd: repo, encoding: 'utf8' }),
    /PARSER_TESTS_OK/,
  );
  assert.deepEqual(fixtureErrors, []);
  const count = calls;
  assert.equal(bridge.submit(s.id, request).id, t.id);
  assert.equal(calls, count);
  assert.ok(toolResults > 0);
  console.log(
    'API_KEY_SUCCESS: native headers, model selection, session resume, approval, real tool execution, tests, result and duplicate receipt passed',
  );
  // Exercise the npm launcher with all service calls confined to deterministic fixtures.
  const state = join(repo, 'launcher-state');
  const launchEnv = {
    ...process.env,
    BRIDGE_STATE_DIR: state,
    MEETSTREAM_API_KEY: meetingKey,
    MEETSTREAM_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    PUBLIC_URL: 'https://bridge.example.com',
    PORT: '0',
    REPO_PATH: repo,
    MEETING_URL: 'https://meet.google.com/abc-defg-hij',
  };
  const launch = () => {
    const child = spawn('npm', ['start'], { env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { child, output: '', closed: once(child, 'close') };
    child.stdout.on('data', (b) => {
      run.output += b;
    });
    child.stderr.on('data', (b) => {
      run.output += b;
    });
    return run;
  };
  launcher = launch();
  const deadline = Date.now() + 45000;
  while (!launcher.output.includes('Admit DeepSeek')) {
    if (launcher.child.exitCode !== null || Date.now() > deadline) throw new Error(launcher.output);
    await new Promise((r) => setTimeout(r, 50));
  }
  const active = JSON.parse(readFileSync(join(state, 'active.json')));
  const endpoint = `http://127.0.0.1:${active.port}`;
  const post = async (path, body, authorization) => {
    const response = await fetch(endpoint + path, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const tool = (name, args) =>
    post(
      `/mia/${active.sessionId}/${name}`,
      { name, bot: { bot_id: 'fixture-bot' }, args },
      miaConfig.agent.custom_functions[0].headers.Authorization,
    );
  const admin = (name, task_id) =>
    post(
      '/admin/' + name,
      { session_id: active.sessionId, ...(task_id ? { task_id } : {}) },
      'Bearer ' + active.adminToken,
    );
  const answer = await tool('ask_repository', {
    request_id: 'launcher-question',
    text: 'Name the parser function.',
  });
  assert.equal(answer.status, 'completed');
  assert.match(answer.result, /parseName/);
  writeFileSync(join(repo, 'parser.js'), original);
  writeIssued = false;
  const proposal = await tool('propose_task', {
    request_id: 'launcher-fix',
    text: 'FIX_APPROVED_PARSER: fix empty input and run the regression test.',
  });
  assert.equal(proposal.status, 'awaiting_approval');
  assert.equal(readFileSync(join(repo, 'parser.js'), 'utf8'), original);
  await admin('approve', proposal.task_id);
  await admin('approve', proposal.task_id);
  let status;
  const taskDeadline = Date.now() + 30000;
  do {
    status = await admin('status');
    if (Date.now() > taskDeadline) throw new Error('Launcher engineering deadline exceeded');
    await new Promise((r) => setTimeout(r, 50));
  } while (status.tasks.find((t) => t.id === proposal.task_id).status === 'running');
  assert.equal(status.tasks.find((t) => t.id === proposal.task_id).status, 'completed');
  assert.match(
    execFileSync(process.execPath, ['parser.test.js'], { cwd: repo, encoding: 'utf8' }),
    /PARSER_TESTS_OK/,
  );
  assert.equal(
    (
      await tool('propose_task', {
        request_id: 'launcher-fix',
        text: 'FIX_APPROVED_PARSER: fix empty input and run the regression test.',
      })
    ).task_id,
    proposal.task_id,
  );
  assert.equal((await admin('status')).tasks.length, 2);
  const stopper = spawn('npm', ['stop'], { env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  stopper.stdout.resume();
  stopper.stderr.resume();
  assert.equal((await once(stopper, 'close'))[0], 0);
  assert.equal((await launcher.closed)[0], 0);
  assert.ok(departed);
  const removal = meetingCalls.findIndex(([path]) => path.endsWith('/remove_bot'));
  const deletion = meetingCalls.findIndex(([, method]) => method === 'DELETE');
  assert.ok(removal >= 0 && deletion > removal);
  assert.equal(
    meetingCalls.filter(
      ([path, , body]) =>
        path.endsWith('/send_message') &&
        body.message.includes(proposal.task_id) &&
        body.message.includes('started'),
    ).length,
    1,
  );
  console.log(
    'API_KEY_LAUNCHER: npm start preflight, real Harness Q&A/tools, approval, duplicate protection, REST chat and npm stop passed',
  );
  for (scenario of ['unauthorized', 'quota']) {
    const before = calls;
    await assert.rejects(
      harness.run({ repo, mode: 'read-only', prompt: 'Fail closed for this fixture.' }),
      /Harness failed/,
    );
    assert.equal(calls - before, 1, 'Permanent authentication/quota failures must not be retried');
    const resourcesBefore = meetingCalls.length;
    launcher = launch();
    assert.equal((await launcher.closed)[0], 1);
    assert.equal(
      meetingCalls.length,
      resourcesBefore,
      'Failed preflight must not create cloud resources',
    );
    assert.ok(!launcher.output.includes(key));
    assert.match(
      launcher.output,
      scenario === 'quota' ? /usable balance/ : /API key|login/,
      launcher.output,
    );
    console.log(`API_KEY_FAILURE: ${scenario} failed closed in runtime and npm-start preflight`);
  }
} finally {
  if (launcher && launcher.child.exitCode === null) {
    launcher.child.kill('SIGTERM');
    await launcher.closed;
  }
  await bridge.close(s.id);
  store.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(repo, { recursive: true, force: true });
}
