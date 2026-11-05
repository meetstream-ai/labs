import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCanvaBridge, mcpSecret } from '../src/canvaBridge.js';

test('bridge derives a stable non-secret credential', () => {
  assert.equal(mcpSecret('key'), mcpSecret('key'));
  assert.notEqual(mcpSecret('key'), 'key');
});

test('bridge filters tools and blocks every tool except generate-design', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const bridge = createCanvaBridge('key', { spawn: () => child });
  let input = '';
  child.stdin.on('data', (chunk) => { input += chunk; });
  const listed = bridge.handle;
  assert.equal(typeof listed, 'function');
  const blocked = await new Promise((resolve) => {
    const request = new EventEmitter();
    request.headers = { authorization: `Bearer ${bridge.secret}` };
    request.setEncoding = () => {};
    const response = { writeHead: () => response, end: (body) => resolve(JSON.parse(body)) };
    bridge.handle(request, response);
    request.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete-design' } }));
    request.emit('end');
  });
  assert.equal(blocked.error.code, -32601);
  assert.equal(input, '');
});
