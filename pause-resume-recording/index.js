import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { MeetStreamClient, interpretBotStatus } from './src/client.js';
import { listenForKeys, parseSequence } from './src/keyboard.js';
import { log } from './src/log.js';
import { envInt, optionalEnv, requireEnv, sleep } from './src/util.js';

/**
 * pause-resume-recording
 *
 * A small control CLI for MeetStream's recording privacy window:
 *
 *   POST /bots/{bot_id}/pause_recording    (empty body)
 *   POST /bots/{bot_id}/resume_recording   (empty body)
 *
 * The bot stays in the meeting the whole time - only the recording stops and
 * restarts. Keep an audit trail of every pause/resume, because "we paused for
 * that part" is exactly the claim you may later need to evidence.
 */

const state = {
  client: null,
  botId: null,
  paused: false,
  finished: false,
  keyboard: null,
  /** @type {Array<{ action: string, at: Date, ok: boolean, detail: string }>} */
  audit: [],
  startedAt: null,
};

const HELP = `
  p  pause recording   (privacy window opens)
  r  resume recording  (privacy window closes)
  t  show bot status
  s  stop: remove the bot from the meeting and exit
  ?  show this help
  q  quit this CLI and LEAVE the bot running in the meeting
`;

async function main() {
  const apiKey = requireEnv('MEETSTREAM_API_KEY');
  const existingBotId = optionalEnv('BOT_ID');
  const meetingLink = optionalEnv('MEETING_LINK');
  const botName = optionalEnv('BOT_NAME', 'MeetStream Recorder');
  const everyoneLeftTimeout = envInt('EVERYONE_LEFT_TIMEOUT', 60);
  const autoSequenceSpec = optionalEnv('AUTO_SEQUENCE', '30:pause,60:resume,90:stop');

  if (!existingBotId && !meetingLink) {
    throw new Error('Set MEETING_LINK to start a new bot, or BOT_ID to control one that is already running.');
  }

  const client = new MeetStreamClient({
    apiKey,
    timeoutMs: envInt('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: envInt('MAX_RETRIES', 4),
  });
  state.client = client;

  if (existingBotId) {
    state.botId = existingBotId;
    log.info(`Controlling existing bot ${existingBotId}.`);
  } else {
    log.info(`Creating bot for ${meetingLink} ...`);
    const bot = await client.createBot(
      {
        meeting_link: meetingLink,
        bot_name: botName,
        video_required: true,
        automatic_leave: { everyone_left_timeout: everyoneLeftTimeout },
      },
      { idempotencyKey: randomUUID() }
    );
    state.botId = bot.bot_id;
    log.info(`Bot created: bot_id=${bot.bot_id} status=${bot.status ?? 'unknown'}`);
  }

  state.startedAt = new Date();

  const keyboard = listenForKeys({ onKey: handleKey });
  state.keyboard = keyboard;

  if (keyboard.available) {
    log.info('Recording control ready.');
    log.raw(`${HELP}\n`);
    // Keep the event loop alive; all work happens in key handlers.
    await new Promise(() => {});
  } else {
    log.warn('stdin is not a TTY, so single-key control is unavailable.');
    log.info(`Running the scripted sequence instead: ${autoSequenceSpec}`);
    await runSequence(parseSequence(autoSequenceSpec));
    await finish(0);
  }
}

/**
 * @param {string} key
 */
async function handleKey(key) {
  if (state.finished) return;

  switch (key) {
    case 'p':
      await pause();
      break;
    case 'r':
      await resume();
      break;
    case 't':
      await showStatus();
      break;
    case 's':
      await stopBot();
      await finish(0);
      break;
    case '?':
    case 'h':
      log.raw(`${HELP}\n`);
      break;
    case 'q':
      log.warn('Quitting the CLI. The bot is still in the meeting and still recording.');
      log.warn(`Remove it later with: GET /bots/${state.botId}/remove_bot`);
      await finish(0);
      break;
    case 'ctrl+c':
      log.info('Ctrl+C - removing the bot before exiting.');
      await stopBot();
      await finish(130);
      break;
    default:
      break;
  }
}

/**
 * POST /bots/{bot_id}/pause_recording - empty body.
 */
async function pause() {
  if (state.paused) {
    log.warn('Recording is already paused.');
    return;
  }
  try {
    const data = await state.client.pauseRecording(state.botId);
    state.paused = true;
    record('pause', true, messageOf(data, 'Recording paused.'));
    log.info('PAUSED - the bot is still in the meeting, but nothing is being recorded.');
  } catch (err) {
    record('pause', false, err.message);
    log.error(`Pause failed: ${err.message}`);
  }
}

/**
 * POST /bots/{bot_id}/resume_recording - empty body.
 */
async function resume() {
  if (!state.paused) {
    log.warn('Recording is not paused.');
    return;
  }
  try {
    const data = await state.client.resumeRecording(state.botId);
    state.paused = false;
    record('resume', true, messageOf(data, 'Recording resumed.'));
    log.info('RESUMED - recording again.');
  } catch (err) {
    record('resume', false, err.message);
    log.error(`Resume failed: ${err.message}`);
  }
}

async function showStatus() {
  try {
    const { status } = interpretBotStatus(await state.client.getBotStatus(state.botId));
    log.info(`Bot status: ${status} | local recording state: ${state.paused ? 'PAUSED' : 'recording'}`);
  } catch (err) {
    log.error(`Status check failed: ${err.message}`);
  }
}

async function stopBot() {
  if (!state.botId) return;
  try {
    const { alreadyGone } = await state.client.removeBot(state.botId);
    record('stop', true, alreadyGone ? 'Bot had already left.' : 'Bot removed from meeting.');
  } catch (err) {
    record('stop', false, err.message);
    log.error(`remove_bot failed: ${err.message}`);
  }
}

/**
 * Run a scripted pause/resume/stop sequence (non-interactive mode).
 *
 * @param {Array<{ atSeconds: number, action: 'pause'|'resume'|'stop' }>} steps
 */
async function runSequence(steps) {
  let elapsed = 0;
  for (const step of steps) {
    const waitSeconds = Math.max(0, step.atSeconds - elapsed);
    if (waitSeconds > 0) {
      log.info(`Waiting ${waitSeconds}s until t+${step.atSeconds}s (${step.action})...`);
      await sleep(waitSeconds * 1000);
      elapsed = step.atSeconds;
    }
    if (step.action === 'pause') await pause();
    else if (step.action === 'resume') await resume();
    else {
      await stopBot();
      return;
    }
  }
}

/**
 * Append to the local audit trail.
 *
 * @param {string} action
 * @param {boolean} ok
 * @param {string} detail
 */
function record(action, ok, detail) {
  state.audit.push({ action, at: new Date(), ok, detail });
}

/**
 * @param {any} data
 * @param {string} fallback
 * @returns {string}
 */
function messageOf(data, fallback) {
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) {
    return data.message;
  }
  return fallback;
}

/**
 * Print the privacy-window audit trail and exit.
 * @param {number} code
 */
async function finish(code) {
  if (state.finished) return;
  state.finished = true;
  state.keyboard?.close();

  if (state.audit.length) {
    log.raw('\nRecording control audit trail\n');
    log.raw(`bot_id: ${state.botId}\n`);
    let pausedAt = null;
    for (const item of state.audit) {
      const stamp = item.at.toISOString();
      const marker = item.ok ? 'ok  ' : 'FAIL';
      log.raw(`  ${stamp}  ${marker}  ${item.action.padEnd(6)} ${item.detail}\n`);
      if (item.ok && item.action === 'pause') pausedAt = item.at;
      if (item.ok && item.action === 'resume' && pausedAt) {
        const seconds = Math.round((item.at.getTime() - pausedAt.getTime()) / 1000);
        log.raw(`      -> privacy window of ${seconds}s is absent from the recording\n`);
        pausedAt = null;
      }
    }
    if (pausedAt) {
      log.raw('      -> recording was still paused when this session ended\n');
    }
    log.raw('\n');
  }

  process.exit(code);
}

// Only reached when stdin is not a TTY; in raw mode Ctrl+C arrives as a
// keypress and is handled in handleKey() instead.
process.on('SIGINT', async () => {
  if (state.keyboard?.available) return;
  log.info('SIGINT - removing the bot before exiting.');
  await stopBot();
  await finish(130);
});

main().catch(async (err) => {
  log.error(err.message);
  state.keyboard?.close();
  process.exit(1);
});
