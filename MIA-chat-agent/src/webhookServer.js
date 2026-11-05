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
      // `event` is always present. Every ending arrives once with event
      // `bot.stopped`; the reason (bot.kicked, bot.notallowed, ...) is in bot_event.
      const name = event.event || event.bot_event;
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

// Why a bot ended. `bot_event` is authoritative; when it is missing, fall back to
// bot_status compared case-insensitively. A kick and a clean exit both report
// bot_status "Stopped", so bot_status alone cannot tell them apart.
export function terminalReason(payload = {}) {
  if (payload.bot_event) return payload.bot_event;
  const status = String(payload.bot_status || '').toLowerCase();
  if (status === 'notallowed') return 'bot.notallowed';
  if (status === 'denied') return 'bot.denied';
  if (status === 'error' || status === 'failed') return 'bot.failed';
  return 'bot.stopped';
}

export function formatWebhookEvent(payload = {}) {
  const { bot_event = '', event = '', bot_status = '', message = '' } = payload;
  const heard = payload.new_text
    || payload.data?.new_text
    || payload.channel?.alternatives?.[0]?.transcript
    || payload.result?.channel?.alternatives?.[0]?.transcript
    || (payload.end_of_turn ? payload.transcript : '');
  // `event` is the generic name and always present; `bot_event` is the specific
  // one (equal to `event` except on terminals).
  const name = bot_event || event;
  if (heard?.trim()) return `Heard: ${heard.trim()}`;
  if (name === 'bot.in_waiting_room') return '⏳ Waiting to be admitted';
  if (name === 'bot.inmeeting') return '✅ Bot joined the meeting';
  if (name === 'bot.recording') return '✅ Bot is listening';
  if (name === 'bot.leaving') return '⏳ Bot is leaving';
  // Every ending arrives as event `bot.stopped`; bot_event carries the reason.
  // status_code is 200 for a clean exit or kick, 500 for notallowed/denied/failed.
  if ((event || bot_event) === 'bot.stopped') {
    const reason = terminalReason(payload);
    if (reason === 'bot.kicked') return '⚠️ A participant removed the bot from the meeting';
    if (reason === 'bot.notallowed') return '❌ Never admitted (waiting-room timeout)';
    if (reason === 'bot.denied') return '❌ The host denied the bot entry';
    if (reason === 'bot.failed') return `❌ Bot ended with an error${message ? `: ${message}` : ''}`;
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
