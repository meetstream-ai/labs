import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';
const PROXY_PATH = fileURLToPath(new URL('../node_modules/mcp-remote/dist/proxy.js', import.meta.url));

export function mcpSecret(apiKey) {
  return createHmac('sha256', apiKey).update('mia-canva-mcp').digest('base64url');
}

function authorized(header, secret) {
  const actual = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createCanvaBridge(apiKey, options = {}) {
  const secret = mcpSecret(apiKey);
  const child = (options.spawn || spawn)(process.execPath, [
    PROXY_PATH,
    CANVA_MCP_URL,
    '--transport', 'http-only',
    '--silent'
  ], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  const pending = new Map();
  let nextId = 1;
  let stoppedError;

  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null || !pending.has(message.id)) return;
    const { resolve, originalId, method } = pending.get(message.id);
    pending.delete(message.id);
    if (method === 'tools/list' && message.result?.tools) {
      message.result.tools = message.result.tools.filter((tool) => tool.name === 'generate-design');
    }
    message.id = originalId;
    resolve(message);
  });

  child.once('exit', (code) => {
    stoppedError = new Error(`Canva bridge stopped with code ${code}.`);
    for (const { reject } of pending.values()) reject(stoppedError);
    pending.clear();
  });

  function send(message, timeoutMs = 90000) {
    if (stoppedError) return Promise.reject(stoppedError);
    if (message.method === 'tools/call' && message.params?.name !== 'generate-design') {
      return Promise.resolve({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Tool not allowed.' } });
    }
    if (message.id == null) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return Promise.resolve(null);
    }
    const internalId = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(internalId);
        reject(new Error('Canva MCP request timed out.'));
      }, timeoutMs);
      pending.set(internalId, {
        originalId: message.id,
        method: message.method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      child.stdin.write(`${JSON.stringify({ ...message, id: internalId })}\n`);
    });
  }

  async function handle(request, response) {
    if (!authorized(request.headers.authorization, secret)) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', async () => {
      try {
        const result = await send(JSON.parse(body || '{}'));
        if (!result) {
          response.writeHead(202).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'mia-owner'
        }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(502, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: error.message } }));
      }
    });
  }

  return {
    handle,
    secret,
    close: () => {
      child.stdin.end();
      setTimeout(() => child.kill(), 1000).unref();
    }
  };
}
