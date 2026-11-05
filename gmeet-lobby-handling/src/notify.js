/**
 * Notifications.
 *
 * Always logs to stdout. If NOTIFY_WEBHOOK_URL is set, also POSTs a small JSON
 * document there so you can wire it into whatever you already use for alerting.
 * Delivery failures are logged, never thrown - a broken alerting hook must not
 * take down the webhook receiver.
 */

const LEVEL_PREFIX = {
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

export function createNotifier({ webhookUrl, timeoutMs = 10_000 } = {}) {
  async function notify(level, title, details = {}) {
    const line = `[${LEVEL_PREFIX[level] ?? level}] ${title}`;
    const body = Object.entries(details)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `    ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');

    if (level === 'error') console.error(body ? `${line}\n${body}` : line);
    else console.log(body ? `${line}\n${body}` : line);

    if (!webhookUrl) return;

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'meetstream-gmeet-lobby-handling',
          level,
          title,
          details,
          sent_at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        console.error(`    (notify webhook returned HTTP ${res.status})`);
      }
    } catch (error) {
      console.error(`    (notify webhook failed: ${error.message})`);
    }
  }

  return {
    info: (title, details) => notify('info', title, details),
    warn: (title, details) => notify('warn', title, details),
    error: (title, details) => notify('error', title, details),
  };
}
