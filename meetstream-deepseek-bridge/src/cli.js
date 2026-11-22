import {
  readFileSync,
  chmodSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Store, acquireOwner } from './store.js';
import { Harness, harnessBin } from './harness.js';
import { Bridge } from './bridge.js';
import { MeetStream, miaConfig, terminal } from './meetstream.js';
import { ask, setting } from './setup.js';
import { startTunnel } from './tunnel.js';
const root = resolve(import.meta.dirname, '..'),
  state = resolve(process.env.BRIDGE_STATE_DIR || resolve(root, '.state'));
const cliArgs = process.argv.slice(2).filter((x) => x !== '--');
const command =
  cliArgs.find(
    (x) => ['approve', 'status', 'doctor', 'stop', 'start'].includes(x) && x !== 'start',
  ) ||
  cliArgs[0] ||
  'start';
const bin = harnessBin();
export function meetingUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    !(
      u.hostname === 'meet.google.com' ||
      /(^|\.)zoom\.us$/.test(u.hostname) ||
      ['teams.microsoft.com', 'teams.live.com'].includes(u.hostname)
    )
  )
    throw new Error('Use a Google Meet, Zoom or Teams HTTPS meeting URL');
  return u.href;
}
export function repoPath(value) {
  const p = realpathSync(value);
  return realpathSync(
    execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  );
}
async function main() {
  const verbs = ['start', 'stop', 'status', 'approve', 'doctor'];
  const first = cliArgs[0] === 'start' ? cliArgs[1] : cliArgs[0];
  if (
    (first && !verbs.includes(first) && !['--meeting', '--probe'].includes(first)) ||
    cliArgs.some((a) => a.startsWith('--') && !['--meeting', '--probe'].includes(a)) ||
    (cliArgs.includes('--probe') && command !== 'doctor') ||
    (cliArgs.includes('--meeting') && command !== 'start')
  ) {
    throw new Error(
      'Unknown command. Use npm start, npm start -- status, npm start -- approve, npm run doctor, or npm stop.',
    );
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  if (['approve', 'status', 'stop'].includes(command)) {
    const activePath = resolve(state, 'active.json');
    if (!existsSync(activePath)) {
      console.log('Bridge is already stopped. Run npm start to begin.');
      return;
    }
    const active = JSON.parse(readFileSync(activePath, 'utf8'));
    const idx = cliArgs.indexOf(command);
    const session_id = cliArgs[idx + 1] || active.sessionId;
    const post = async (operation, body) => {
      const response = await fetch(`http://127.0.0.1:${active.port}/admin/${operation}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + active.adminToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      return response.json();
    };
    if (command !== 'stop') {
      let task_id = cliArgs[idx + 2];
      if (command === 'approve' && !task_id) {
        if (cliArgs[idx + 1])
          throw new Error(
            'Usage: npm start -- approve SESSION_ID TASK_ID, or npm start -- approve',
          );
        const { tasks } = await post('status', { session_id });
        const proposals = tasks.filter((t) => t.status === 'awaiting_approval');
        if (!proposals.length) {
          console.log('No tasks are waiting for approval.');
          return;
        }
        for (const [i, task] of proposals.entries())
          console.log(`\n${i + 1}. ${JSON.stringify(task.text)}\n   Task ${task.id}`);
        const choice = await ask(
          'Review the exact request above. Enter its number to approve, or press Enter to cancel',
        );
        if (!choice) return;
        if (!/^\d+$/.test(choice) || !proposals[Number(choice) - 1])
          throw new Error('Invalid task number; nothing was approved.');
        task_id = proposals[Number(choice) - 1].id;
      }
      console.log(
        JSON.stringify(
          await post(command, { session_id, ...(task_id ? { task_id } : {}) }),
          null,
          2,
        ),
      );
      return;
    }
    console.log('Stopping the bridge. Please wait for bot cleanup...');
    // A stop request acknowledges intent immediately; ownership is released only after cleanup.
    try {
      await post('stop', { session_id });
    } catch {
      /* Recover offline only after obtaining the native owner lock. */
    }
    const deadline = Date.now() + 150000;
    let owner;
    while (!owner) {
      try {
        owner = acquireOwner(resolve(state, 'owner.sqlite'));
      } catch {
        if (Date.now() >= deadline)
          throw new Error('Shutdown is still running. Keep .state and retry npm stop.');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const store = new Store(resolve(state, 'bridge.sqlite'));
    try {
      const bridge = new Bridge(store, new Harness(bin));
      const ms = new MeetStream(process.env.MEETSTREAM_API_KEY, process.env.MEETSTREAM_BASE_URL);
      let pending = false;
      for (const s of store.all('session').filter((s) => !s.cleanedAt)) {
        if (!(await ms.cleanup(store, await bridge.close(s.id)))) pending = true;
      }
      if (pending) {
        console.error(
          'Cleanup is still pending. Restore connectivity, keep .state and run npm stop again.',
        );
        process.exitCode = 1;
      } else console.log('Stopped. Owned bots and configurations are cleaned up.');
    } finally {
      store.close();
      owner.close();
    }
    return;
  }
  const harness = new Harness(bin, Number(process.env.TASK_TIMEOUT_MS || 900000));
  if (command === 'doctor') {
    console.log('Harness version:', harness.check());
    console.log(
      'Repository:',
      process.env.REPO_PATH ? repoPath(process.env.REPO_PATH) : 'REPO_PATH is missing',
    );
    console.log('MeetStream key:', process.env.MEETSTREAM_API_KEY ? 'configured' : 'missing');
    console.log(
      'Public connection:',
      process.env.PUBLIC_URL ? 'configured externally' : 'managed ngrok on npm start',
    );
    if (cliArgs.includes('--probe')) {
      console.log('Harness backend:', harness.validateAuth());
      console.log(
        await harness.run({
          repo: repoPath(process.env.REPO_PATH),
          mode: 'read-only',
          prompt: 'Reply exactly HARNESS_OK. Do not use tools.',
        }),
      );
    }
    return;
  }
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be a number from 0 to 65535');
  const owner = acquireOwner(resolve(state, 'owner.sqlite'));
  const store = new Store(resolve(state, 'bridge.sqlite'));
  const ms = new MeetStream(process.env.MEETSTREAM_API_KEY, process.env.MEETSTREAM_BASE_URL);
  const bridge = new Bridge(store, harness);
  const controller = new AbortController();
  const signal = controller.signal;
  let server,
    s,
    tunnel,
    stopping = false,
    maintenance,
    shutdown,
    finishSetup;
  const setupDone = new Promise((r) => {
    finishSetup = r;
  });
  const stop = () => {
    if (!stopping) console.log('Stopping the bridge and its owned work...');
    stopping = true;
    controller.abort();
    return (shutdown ??= (async () => {
      await setupDone;
      clearInterval(maintenance);
      let cleanupPending = false;
      try {
        for (const item of store.all('session').filter((x) => !x.cleanedAt)) {
          if (!(await ms.cleanup(store, await bridge.close(item.id)))) {
            console.error('Cleanup pending for session', item.id);
            cleanupPending = true;
            process.exitCode = 1;
          }
        }
      } finally {
        await tunnel?.stop();
        await server?.closeConnections();
        await new Promise((r) => (server ? server.close(r) : r()));
        store.close();
        owner.close();
      }
      console.log(
        cleanupPending
          ? 'Stopped locally. Keep .state and retry npm stop to finish cloud cleanup.'
          : 'Stopped. Pending work cancelled and owned resources cleaned up.',
      );
    })());
  };
  const requestStop = () => {
    void stop().catch(() => {
      console.error('Shutdown failed. Keep .state and retry npm stop.');
      process.exitCode = 1;
    });
  };
  // npm can forward a second terminal signal while asynchronous cleanup is still running.
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    const token = process.env.BRIDGE_TOKEN || randomBytes(32).toString('hex');
    const adminToken = randomBytes(32).toString('hex');
    const { createServer } = await import('./server.js');
    server = createServer({
      bridge,
      store,
      meetstream: ms,
      token,
      adminToken,
      onStop: requestStop,
    });
    await new Promise((r, j) => {
      server.once('error', j);
      server.listen(port, '127.0.0.1', r);
    });
    const active = { pid: process.pid, port: server.address().port, adminToken };
    const saveActive = () =>
      writeFileSync(resolve(state, 'active.json'), JSON.stringify(active), { mode: 0o600 });
    saveActive();
    console.log('Harness version:', harness.check());
    if (process.env.DSH_ACCOUNT !== 'true' && process.env.DSH_LOCAL_OLLAMA !== 'true') {
      await setting('DEEPSEEK_API_KEY', 'Paste your funded DeepSeek API key', {
        secret: true,
        signal,
      });
    }
    console.log('Harness backend:', harness.validateAuth());
    await setting('MEETSTREAM_API_KEY', 'Paste your MeetStream API key', { secret: true, signal });
    ms.key = process.env.MEETSTREAM_API_KEY;
    // Credentials are available now, including for cleanup left over from an interrupted run.
    for (const old of store.all('session').filter((x) => !x.cleanedAt)) {
      if (!(await ms.cleanup(store, await bridge.close(old.id))))
        throw new Error('Previous session cleanup is still pending: ' + old.id);
    }
    const repo = repoPath(
      await setting('REPO_PATH', 'Path to a disposable copy of your Git repository', { signal }),
    );
    const meetingArg = cliArgs.indexOf('--meeting');
    if (meetingArg >= 0) {
      if (!cliArgs[meetingArg + 1]) throw new Error('Paste a meeting link after --meeting');
      process.env.MEETING_URL = cliArgs[meetingArg + 1];
    }
    const meeting = meetingUrl(
      await setting('MEETING_URL', 'Paste the meeting invitation link', { save: false, signal }),
    );
    console.log(
      'Checking model access with a small read-only request (uses your configured model)...',
    );
    await new Harness(bin, Math.min(harness.timeout, 60000)).run({
      repo,
      mode: 'read-only',
      prompt: 'Reply exactly HARNESS_OK. Do not use tools.',
      signal,
    });
    signal.throwIfAborted();
    console.log('Model access confirmed.');
    let publicUrl = process.env.PUBLIC_URL;
    if (!publicUrl) {
      await setting('NGROK_AUTHTOKEN', 'Paste your ngrok authtoken', { secret: true, signal });
      console.log('Opening the meeting connection...');
      tunnel = startTunnel({
        port: active.port,
        state,
        signal,
        onExit: () => {
          console.error('Meeting connection ended. Stopping the bridge.');
          process.exitCode = 1;
          requestStop();
        },
      });
      publicUrl = await tunnel.url;
    }
    const origin = new URL(publicUrl);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error('PUBLIC_URL must be an HTTPS origin');
    signal.throwIfAborted();
    s = bridge.create({ repo, meetingUrl: meeting });
    s.cleanupPending = true;
    store.put('session', s.id, s);
    active.sessionId = s.id;
    saveActive();
    s.agentCreatePending = true;
    store.put('session', s.id, s);
    const mia = await ms.request(
      '/mia',
      'POST',
      miaConfig(origin.origin, token, s.id, {
        provider: process.env.MIA_PROVIDER,
        model: process.env.MIA_MODEL,
        voice: process.env.MIA_VOICE,
      }),
    );
    if (!mia.agent_config_id) throw new Error('MIA response lacks agent_config_id');
    s.agentId = mia.agent_config_id;
    s.agentCreatePending = false;
    store.put('session', s.id, s);
    signal.throwIfAborted();
    s.botCreatePending = true;
    store.put('session', s.id, s);
    const bot = await ms.request('/bots/create_bot', 'POST', {
      meeting_link: meeting,
      bot_name: 'DeepSeek Meeting Agent',
      agent_config_id: s.agentId,
      video_required: false,
      callback_url: `${origin.origin}/lifecycle/${s.id}?key=${token}`,
      live_transcription_required: {
        webhook_url: `${origin.origin}/transcript/${s.id}?key=${token}`,
      },
      recording_config: {
        retention: { type: 'timed', hours: 48 },
        transcript: {
          provider: {
            deepgram_streaming: {
              model: 'nova-2',
              transcription_mode: 'sentence',
              language: 'en',
              punctuate: true,
              smart_format: true,
              endpointing: 300,
              vad_events: true,
              utterance_end_ms: 1000,
              encoding: 'linear16',
              channels: 1,
            },
          },
        },
      },
      custom_attributes: { deepseek_bridge_session: s.id },
      deduplication_key: 'deepseek-' + s.id,
      automatic_leave: {
        waiting_room_timeout: 600,
        everyone_left_timeout: 60,
        voice_inactivity_timeout: 1800,
      },
    });
    if (!bot.bot_id) throw new Error('Bot response lacks bot_id');
    s.botId = bot.bot_id;
    s.botCreatePending = false;
    store.put('session', s.id, s);
    signal.throwIfAborted();
    console.log(
      `Session ${s.id}\nBot ${s.botId}\nAdmit DeepSeek Meeting Agent. Say “DeepSeek, ask the repository …”\nTo review and approve a proposal, open another terminal here and run: npm start -- approve\nCtrl+C or npm stop removes the owned bot and cancels pending tasks.`,
    );
    maintenance = setInterval(async () => {
      try {
        const current = bridge.session(s.id);
        if (current.closed) {
          await ms.cleanup(store, current);
          return;
        }
        if (terminal(await ms.request(`/bots/${s.botId}/status`))) {
          await bridge.close(s.id);
          await ms.cleanup(store, bridge.session(s.id));
        }
      } catch {
        if (!stopping) console.error('Meeting lifecycle check failed; cleanup remains recorded');
      }
    }, 30000);
    finishSetup();
  } catch (e) {
    if (s && [400, 401, 403, 404, 422].includes(e.status)) {
      if (!s.agentId) s.agentCreatePending = false;
      if (!s.botId) s.botCreatePending = false;
      store.put('session', s.id, s);
    }
    finishSetup();
    if (!stopping && e.name !== 'AbortError') {
      console.error(e.message);
      process.exitCode = 1;
    }
    await stop();
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
