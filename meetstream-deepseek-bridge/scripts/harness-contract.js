// Opt-in actual pinned Harness + scripted model protocol test. No cloud inference.
// The model fixture deliberately requests one bash write, then returns a final answer.
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Harness } from '../src/harness.js';
const harness = new Harness();
harness.check();
const root = mkdtempSync(join(tmpdir(), 'meetstream-harness-contract-'));
let replies = 0,
  toolName = 'bash';
const api = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const tool = body.tools?.find((t) => t.function.name === toolName);
  const hasToolResult = body.messages.some((m) => m.role === 'tool');
  res.setHeader('Content-Type', 'text/event-stream');
  const emit = (delta, finish_reason = null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  if (!hasToolResult && tool) {
    emit({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call_marker',
          type: 'function',
          function: {
            name: tool.function.name,
            arguments: JSON.stringify(
              toolName === 'write'
                ? { file_path: 'sandbox-marker.txt', content: 'marker' }
                : {
                    description: 'Write a sandbox verification marker',
                    command: 'printf marker > sandbox-marker.txt',
                  },
            ),
          },
        },
      ],
    });
    emit({}, 'tool_calls');
  } else {
    emit({ role: 'assistant', content: 'SANDBOX_CONTRACT_COMPLETE' });
    emit({}, 'stop');
  }
  replies++;
  res.end('data: [DONE]\n\n');
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const patch = join(root, 'fixture.yml');
writeFileSync(
  patch,
  `- id: llm-pi-ai\n  config:\n    providers:\n      sandbox-fixture:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${api.address().port}/v1\n        apiKeyEnv: HARNESS_FIXTURE_KEY\n        models:\n          - id: fixture\n            contextWindow: 32768\n            maxTokens: 1024\n- id: agent-default-model\n  config:\n    provider: sandbox-fixture\n    model: fixture\n- id: skill-filesystem\n  disabled: true\n`,
);
try {
  for (toolName of ['bash', 'write'])
    for (const mode of ['read-only', 'workspace-write']) {
      const repo = join(root, mode + '-' + toolName);
      mkdirSync(repo);
      const child = spawn(
        harness.bin,
        [
          'headless',
          '--patch',
          resolve('config/bridge.yml'),
          '--patch',
          resolve('config', mode + '.yml'),
          '--patch',
          patch,
          '--json',
          '-',
        ],
        {
          cwd: repo,
          env: { ...process.env, HARNESS_FIXTURE_KEY: 'test-only' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      let output = '',
        err = '';
      child.stdout.on('data', (b) => (output += b));
      child.stderr.on('data', (b) => (err += b));
      child.stdin.end('Execute the sandbox contract fixture.');
      const [code] = await once(child, 'close');
      clearTimeout(timer);
      assert.equal(code, 0, err);
      assert.match(output, /tool_call/, 'Actual tool call must have occurred');
      assert.match(output, /SANDBOX_CONTRACT_COMPLETE/);
      assert.equal(existsSync(join(repo, 'sandbox-marker.txt')), mode === 'workspace-write');
      console.log(
        mode + ': actual ' + toolName + ' write ' + (mode === 'read-only' ? 'blocked' : 'allowed'),
      );
    }
  console.log('HARNESS_SANDBOX_CONTRACT_PASSED; scripted provider responses:', replies);
} finally {
  api.closeAllConnections();
  await new Promise((r) => api.close(r));
  rmSync(root, { recursive: true, force: true });
}
