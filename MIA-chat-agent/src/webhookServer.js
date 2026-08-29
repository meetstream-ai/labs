import express from 'express';
import ngrok from '@ngrok/ngrok';

export function startWebhookServer(port, onEvent = () => {}) {
  const app = express();
  app.use(express.json({ type: '*/*' }));

  app.get('/health', (_request, response) => response.json({ ok: true }));
  app.post(['/webhooks/meetstream', '/webhook'], (request, response) => {
    const event = request.body || {};
    onEvent(event);
    const output = formatWebhookEvent(event);
    if (output) console.log(output);
    response.status(200).send('ok');
  });
  app.use((error, _request, response, _next) => {
    console.error(`❌ Invalid webhook: ${error.message}`);
    response.status(400).send('invalid request');
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => resolve(server));
    server.once('error', (error) => reject(new Error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Stop the other program or choose a different PORT in .env.`
        : `The webhook listener could not start: ${error.message}`
    )));
  });
}

export function createBotEventTracker() {
  const terminalBots = new Set();
  const waiters = new Map();

  return {
    handle(event) {
      // Live API sends `event`; `bot_event` is a legacy/doc alias kept only as a fallback.
      const name = event.event || event.bot_event;
      // `bot.stopped` is the ONE terminal event - `bot_status` says why
      // (Stopped | NotAllowed | Denied | Error). There are no separate kicked/denied events.
      if (!event.bot_id || name !== 'bot.stopped') return;
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

export function formatWebhookEvent(payload = {}) {
  const { bot_event = '', event = '', bot_status = '', message = '' } = payload;
  const heard = payload.new_text
    || payload.data?.new_text
    || payload.channel?.alternatives?.[0]?.transcript
    || payload.result?.channel?.alternatives?.[0]?.transcript
    || (payload.end_of_turn ? payload.transcript : '');
  // Live API sends `event`; `bot_event` is a legacy/doc alias kept only as a fallback.
  const name = event || bot_event;
  if (heard?.trim()) return `Heard: ${heard.trim()}`;
  if (name === 'bot.in_waiting_room') return '⏳ Waiting to be admitted';
  if (name === 'bot.inmeeting') return '✅ Bot joined the meeting';
  if (name === 'bot.recording') return '✅ Bot is listening';
  if (name === 'bot.leaving') return '⏳ Bot is leaving';
  // `bot.stopped` is terminal - bot_status carries the reason. status_code stays 200.
  if (name === 'bot.stopped') {
    if (bot_status === 'NotAllowed') return '❌ Never admitted (waiting-room timeout)';
    if (bot_status === 'Denied') return '❌ The host denied the bot entry';
    if (bot_status === 'Error') return `❌ Bot ended with an error${message ? `: ${message}` : ''}`;
    return '✅ MeetStream reports the bot stopped';
  }
  // `bot.error` is NON-terminal (e.g. streaming provider upstream issue) - the bot keeps running.
  if (name === 'bot.error') return `⚠️ ${message || 'Streaming provider error (bot still running)'}`;
  if (name === 'transcription.failed') return `❌ Transcription failed${message ? `: ${message}` : ''}`;
  if (/agent|bridge|provider|quota|credit|billing/i.test(message)) {
    return `❌ ${message || bot_status || name}`;
  }
  return null;
}

export async function startNgrokTunnel(port) {
  try {
    return await ngrok.forward({ addr: port, authtoken_from_env: true });
  } catch {
    throw new Error('Could not start ngrok. Check NGROK_AUTHTOKEN in .env and your internet connection.');
  }
}
