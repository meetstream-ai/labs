import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
export const SUPPORTED_VERSION = '0.2.1-rc.5';
export function harnessBin() {
  const bundled = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  return process.env.DSH_BIN || (existsSync(bundled) ? bundled : 'dsh');
}
export class Harness {
  constructor(bin = harnessBin(), timeout = 900000) {
    this.bin = bin;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
      throw new Error('TASK_TIMEOUT_MS must be an integer between 1 and 2147483647');
    this.timeout = timeout;
  }
  check() {
    let version;
    try {
      version = execFileSync(this.bin, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
    } catch {
      throw new Error(
        `Install DeepSeek Harness ${SUPPORTED_VERSION}, then reopen Terminal and run npm start. See Quickstart.md.`,
      );
    }
    if (version !== SUPPORTED_VERSION)
      throw new Error(`Harness ${SUPPORTED_VERSION} required; found ${version}`);
    return version;
  }
  validateAuth() {
    for (const flag of ['DSH_ACCOUNT', 'DSH_LOCAL_OLLAMA']) {
      if (process.env[flag] && !['true', 'false'].includes(process.env[flag]))
        throw new Error(`${flag} must be true or false`);
    }
    if (process.env.DSH_ACCOUNT === 'true' && process.env.DSH_LOCAL_OLLAMA === 'true')
      throw new Error('Choose either Harness account mode or local Ollama');
    const backend =
      process.env.DSH_ACCOUNT === 'true'
        ? 'account'
        : process.env.DSH_LOCAL_OLLAMA === 'true'
          ? 'local-ollama'
          : 'api-key';
    if (backend === 'api-key' && !process.env.DEEPSEEK_API_KEY?.trim())
      throw new Error(
        'Set DEEPSEEK_API_KEY for API credits, or explicitly select DSH_ACCOUNT / DSH_LOCAL_OLLAMA',
      );
    return backend;
  }
  async run({
    repo,
    mode,
    sessionId,
    prompt,
    signal,
    onSession = () => {},
    onProgress = () => {},
  }) {
    if (process.env.DSH_ACCOUNT === 'true' && process.env.DSH_LOCAL_OLLAMA === 'true')
      throw new Error('Choose either Harness account mode or local Ollama');
    if (!['read-only', 'workspace-write'].includes(mode))
      throw new Error('Invalid Harness permission mode');
    if (signal?.aborted) throw new Error('Harness cancelled');
    const patch = fileURLToPath(new URL(`../config/${mode}.yml`, import.meta.url));
    const args = [
      '--profile',
      'headless',
      '--patch',
      fileURLToPath(new URL('../config/bridge.yml', import.meta.url)),
      '--patch',
      patch,
      ...(process.env.DSH_ACCOUNT === 'true'
        ? ['--patch', fileURLToPath(new URL('../config/account.yml', import.meta.url))]
        : []),
      ...(process.env.DSH_LOCAL_OLLAMA === 'true'
        ? ['--patch', fileURLToPath(new URL('../config/local-ollama.yml', import.meta.url))]
        : []),
      ...(process.env.DSH_ACCOUNT !== 'true' && process.env.DSH_LOCAL_OLLAMA !== 'true'
        ? ['--patch', fileURLToPath(new URL('../config/api-key.yml', import.meta.url))]
        : []),
      '--json',
      ...(sessionId ? ['--session-id', sessionId] : []),
      '-',
    ];
    // Meeting text goes through stdin, never through a shell or CLI flags.
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./runner.js', import.meta.url)), this.bin, ...args],
      {
        cwd: repo,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...(process.env.DSH_LOCAL_OLLAMA === 'true' ? { OLLAMA_API_KEY: 'ollama' } : {}),
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) =>
              [
                'PATH',
                'HOME',
                'USER',
                'TMPDIR',
                'SHELL',
                'LANG',
                'LC_ALL',
                'DSH_HOME',
                'DEEPSEEK_API_KEY',
                'DEEPSEEK_BASE_URL',
                'DEEPSEEK_MODEL',
                'DSH_ACCOUNT',
                'DSH_LOCAL_OLLAMA',
                'OLLAMA_API_KEY',
              ].includes(k),
            ),
          ),
        },
      },
    );
    let final,
      terminalCode,
      terminalReason,
      terminalStatus,
      failure,
      diagnostic = '',
      stopped = false;
    const kill = (sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch {}
    };
    let escalation;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(stop, this.timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stderr.on('data', (b) => {
      diagnostic = (diagnostic + b.toString()).slice(-2000);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    if (signal?.aborted) stop();
    let received = 0;
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > 16 * 1024 * 1024) {
        failure = new Error('Harness output limit exceeded');
        child.stdout.destroy();
        stop();
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (failure) return;
      try {
        const e = JSON.parse(line);
        if (e.type === 'session' && typeof e.sessionId === 'string') onSession(e.sessionId);
        if (e.type === 'final') final = e;
        if (e.type === 'status' && e.phase === 'turn_end') {
          terminalReason = e.reason?.kind;
          terminalStatus = e.reason?.error?.status;
        }
        if (
          e.type === 'status' &&
          e.phase === 'turn_end' &&
          /^[A-Z_]+$/.test(e.reason?.error?.code || '')
        )
          terminalCode = e.reason.error.code;
        if (e.type === 'error') failure = new Error(e.message);
        if (e.type === 'tool_call' || e.type === 'tool_result') onProgress(e.type, e);
      } catch {
        failure = new Error('Invalid Harness JSON event');
        stop();
      }
    });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      // Terminate any owned background children even if the CLI closed its own pipes first.
      kill('SIGKILL');
      if (failure) throw failure;
      if (signal?.aborted) throw new Error('Harness cancelled');
      if (stopped)
        throw new Error('Harness task deadline exceeded; partial repository changes may remain');
      if (
        code !== 0 ||
        !final ||
        typeof final.text !== 'string' ||
        (final.reason && final.reason.kind !== 'completed') ||
        (terminalReason && terminalReason !== 'completed')
      ) {
        const hint =
          terminalStatus === 402 || terminalCode?.includes('QUOTA')
            ? 'DeepSeek has no usable balance. Fund the selected API/account provider before starting again.'
            : [401, 403].includes(terminalStatus)
              ? 'Check the selected DeepSeek API key or Harness account login and model access.'
              : terminalStatus === 429
                ? 'DeepSeek is rate limiting requests. Wait before trying again.'
                : '';
        throw new Error(
          `Harness failed (${code}${terminalCode ? ': ' + terminalCode : ''}); inspect local Harness session. ${hint || (diagnostic.includes('login') ? 'Authentication may be required.' : '')}`,
        );
      }
      return final.text;
    } finally {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', stop);
      lines.close();
    }
  }
}
