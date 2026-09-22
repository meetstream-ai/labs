import { spawn } from 'node:child_process';
import { log } from './logger.js';

/**
 * Public HTTPS tunnels for local webhook development.
 *
 * MeetStream delivers webhooks from its own infrastructure. It cannot reach
 * http://localhost:3000. You need a public HTTPS URL that forwards to your
 * laptop, and the URL must be https: plain http is not accepted.
 *
 * Two providers are supported, both driven by their CLI so you are not locked
 * into a Node SDK:
 *
 *   ngrok        stable, requires a free account + authtoken (one-time setup)
 *   cloudflared  no account needed, random URL each run
 *
 * A third mode, `manual`, just uses TUNNEL_URL from your environment. Use that
 * when you already run a tunnel in another terminal, or when you are testing
 * against a deployed staging URL.
 */

const URL_PATTERNS = {
  ngrok: /(https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev))/i,
  cloudflared: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
};

export class Tunnel {
  constructor({ provider, port, timeoutMs = 30_000 }) {
    this.provider = provider;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.url = null;
  }

  /** Resolves with the public https URL, or rejects with an actionable error. */
  async start() {
    if (this.provider === 'manual') {
      throw new Error('Tunnel.start() is not used in manual mode. Read TUNNEL_URL instead.');
    }

    const { command, args } = buildCommand(this.provider, this.port);
    log.info(`starting tunnel: ${command} ${args.join(' ')}`);

    this.proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        log.error(`"${command}" is not installed or not on your PATH.`);
        log.error(installHint(this.provider));
      } else {
        log.error(`tunnel process error: ${err.message}`);
      }
    });

    const url = await this.#waitForUrl();
    this.url = url;
    return url;
  }

  #waitForUrl() {
    return new Promise((resolve, reject) => {
      const pattern = URL_PATTERNS[this.provider];
      let buffer = '';
      let settled = false;

      const onChunk = (chunk) => {
        if (settled) return;
        const text = chunk.toString();
        buffer += text;
        if (process.env.TUNNEL_VERBOSE === 'true') process.stdout.write(text);

        // Surface the single most common ngrok failure immediately instead of
        // making the caller wait out the whole timeout.
        if (/ERR_NGROK_4018|authtoken/i.test(buffer) && /err/i.test(buffer)) {
          settled = true;
          cleanup();
          reject(
            new Error(
              'ngrok needs an authtoken. Run:  ngrok config add-authtoken <token>   (free token at https://dashboard.ngrok.com/get-started/your-authtoken)',
            ),
          );
          return;
        }

        const match = buffer.match(pattern);
        if (match) {
          settled = true;
          cleanup();
          resolve(match[1]);
        }
      };

      const onExit = (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `tunnel process exited with code ${code} before printing a URL.\n${buffer.trim().slice(-800)}`,
          ),
        );
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `timed out after ${this.timeoutMs}ms waiting for a public URL.\n${buffer.trim().slice(-800)}`,
          ),
        );
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.proc.stdout.off('data', onChunk);
        this.proc.stderr.off('data', onChunk);
        this.proc.off('exit', onExit);
      };

      this.proc.stdout.on('data', onChunk);
      this.proc.stderr.on('data', onChunk);
      this.proc.on('exit', onExit);
    });
  }

  stop() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      log.info('tunnel stopped');
    }
  }
}

function buildCommand(provider, port) {
  switch (provider) {
    case 'ngrok':
      // logfmt on stdout is what lets us scrape the URL without the 4040 API.
      return {
        command: 'ngrok',
        args: ['http', String(port), '--log=stdout', '--log-format=logfmt'],
      };
    case 'cloudflared':
      return {
        command: 'cloudflared',
        args: ['tunnel', '--url', `http://localhost:${port}`],
      };
    default:
      throw new Error(
        `Unknown TUNNEL_PROVIDER "${provider}". Use ngrok, cloudflared, or manual.`,
      );
  }
}

function installHint(provider) {
  if (provider === 'ngrok') {
    return [
      'Install ngrok:',
      '  macOS:   brew install ngrok',
      '  other:   https://ngrok.com/download',
      'Then authenticate once:',
      '  ngrok config add-authtoken <your token from https://dashboard.ngrok.com>',
    ].join('\n');
  }
  return [
    'Install cloudflared:',
    '  macOS:   brew install cloudflared',
    '  other:   https://developers.cloudflare.com/cloudflare-tunnel/downloads/',
    'No account or login is needed for a quick tunnel.',
  ].join('\n');
}

/** Reject anything MeetStream cannot deliver to, with the reason spelled out. */
export function assertDeliverable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `callback_url must be https. Got "${parsed.protocol}//". MeetStream does not deliver to plain http.`,
    );
  }
  const host = parsed.hostname;
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error(
      `"${host}" is only reachable from your machine or LAN. MeetStream delivers from the public internet, so it needs a public hostname.`,
    );
  }
  return parsed.toString();
}
