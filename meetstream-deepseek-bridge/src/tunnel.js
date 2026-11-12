import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startTunnel({ port, state, signal, onExit = () => {} }) {
  signal?.throwIfAborted();
  const config = resolve(state, 'ngrok.yml');
  // Isolate this tunnel from other ngrok projects; no inspection server or stored token.
  writeFileSync(config, 'version: 3\nagent:\n  web_addr: false\n  update_check: false\n', {
    mode: 0o600,
  });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('./runner.js', import.meta.url)),
      process.env.NGROK_BIN || 'ngrok',
      'http',
      `http://127.0.0.1:${port}`,
      '--config=' + config,
      '--log=stdout',
      '--log-format=json',
    ],
    {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
      },
    },
  );
  let stopping = false,
    ready = false,
    closed = false,
    code = '';
  const kill = (sig) => {
    try {
      if (process.platform === 'win32') child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch {}
  };
  const exited = new Promise((r) =>
    child.once('close', () => {
      closed = true;
      r();
    }),
  );
  const stop = async () => {
    stopping = true;
    if (closed) return;
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
    kill('SIGKILL');
  };
  const url = new Promise((accept, reject) => {
    let bytes = 0;
    const fail = () =>
      reject(
        new Error(
          `ngrok could not connect${code ? ' (' + code + ')' : ''}. Check its installation, authtoken and account limits, or set PUBLIC_URL for your own HTTPS connection.`,
        ),
      );
    const timer = setTimeout(() => {
      fail();
      void stop();
    }, 30000);
    const lines = createInterface({ input: child.stdout });
    const abort = () => {
      reject(signal.reason);
      void stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = (b) => {
      if (!ready && (bytes += b.length) > 1024 * 1024) {
        fail();
        void stop();
      }
      code = b.toString().match(/ERR_NGROK_\d+/)?.[0] || code;
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    lines.on('line', (line) => {
      try {
        const p = JSON.parse(line);
        if (p.msg === 'started tunnel' && new URL(p.url).protocol === 'https:') {
          ready = true;
          clearTimeout(timer);
          accept(p.url);
        }
      } catch {}
    });
    child.once('error', fail);
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      if (!ready) fail();
      else if (!stopping) onExit();
    });
  });
  return { url, stop };
}
