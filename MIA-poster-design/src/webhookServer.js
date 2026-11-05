import http from 'node:http';
import ngrok from '@ngrok/ngrok';

const terminalEvents = new Set(['bot.stopped', 'bot.kicked', 'bot.denied', 'bot.notallowed', 'bot.failed']);

export function createBotEventTracker() {
  const terminalBots = new Set();
  const waiters = new Map();
  return {
    handle(event) {
      const name = event.bot_event || event.event;
      if (!event.bot_id || !terminalEvents.has(name)) return;
      terminalBots.add(event.bot_id);
      waiters.get(event.bot_id)?.();
    },
    waitForTerminal(botId, timeoutMs = 30000) {
      if (terminalBots.has(botId)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(botId);
          reject(new Error('MeetStream did not confirm that the bot left.'));
        }, timeoutMs);
        waiters.set(botId, () => {
          clearTimeout(timeout);
          waiters.delete(botId);
          resolve();
        });
      });
    }
  };
}

export function formatWebhookEvent(event = {}) {
  const name = event.bot_event || event.event || '';
  if (name === 'bot.in_waiting_room') return '⏳ Waiting to be admitted';
  if (name === 'bot.inmeeting') return '✅ Bot joined the meeting';
  if (name === 'bot.recording') return '✅ Bot is listening';
  if (name === 'tool.started' && event.tool_name === 'generate-design') return '🎨 Canva poster generation started';
  if (name === 'tool.completed' && event.tool_name === 'generate-design') return '✅ Canva poster concepts generated';
  if (name === 'bot.stopped') return '✅ MeetStream reports the bot stopped';
  if (/denied|failed|rejected|notallowed|error/i.test(name)) return `❌ ${event.message || event.bot_status || name}`;
  return null;
}

export function startWebhookServer(port, onEvent = () => {}, onMcpRequest) {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (request.method === 'POST' && request.url === '/mcp' && onMcpRequest) {
      onMcpRequest(request, response);
      return;
    }
    if (request.method !== 'POST' || !['/webhooks/meetstream', '/webhook'].includes(request.url)) {
      response.writeHead(404).end('not found');
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      try {
        const event = JSON.parse(body || '{}');
        onEvent(event);
        const output = formatWebhookEvent(event);
        if (output) console.log(output);
        response.writeHead(200).end('ok');
      } catch {
        response.writeHead(400).end('invalid request');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

export async function startNgrokTunnel(port) {
  try {
    return await ngrok.forward({ addr: port, authtoken_from_env: true });
  } catch {
    throw new Error('Could not start ngrok. Check NGROK_AUTHTOKEN.');
  }
}
