// `node index.js create-bot`: send a MeetStream bot into a Zoom meeting using
// the mint URL this server exposes.
//
//   POST https://api.meetstream.ai/api/v1/bots/create_bot
//   Authorization: Token <MEETSTREAM_API_KEY>
//   {
//     "meeting_link": "https://zoom.us/j/...",
//     "bot_name": "Notetaker",
//     "zoom": { "zak_url": "https://<PUBLIC_BASE_URL>/zoom/zak?user_id=alice&auth=..." }
//   }
//
// Rules the API enforces (and this file checks first, so the error is local):
//   - zak_url OR obf_url, never both (400 "Pass only one of zoom.zak_url or zoom.obf_url")
//   - https, with a host, at most 4096 characters
//   - no meeting_number on obf_url: MeetStream appends it at join time
//   - use_zoom_obf / zoom_oauth_connection_user_id are rejected; never sent here

import { redactUrl, USER_ID_PATTERN } from './auth.js';
import { assertPublicHttpsUrl } from './config.js';

const MAX_URL_LENGTH = 4096;
const MODES = new Set(['zak', 'obf', 'guest']);
// create_bot retry policy: only 429, 5xx and network errors are retried, with a
// hard cap. Any other 4xx (400/401/403/404/409) is final and thrown at once.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Strip anything secret out of text that is about to be printed: the mint
 * shared secret (it rides on every zak_url / obf_url, and an API validation
 * error may echo the URL back) and the Zoom meeting passcode (`pwd=`).
 */
export function scrubSecrets(text, { mintSecret, meeting } = {}) {
  let out = String(text ?? '');
  if (mintSecret) out = out.split(mintSecret).join('***');
  if (mintSecret) out = out.split(encodeURIComponent(mintSecret)).join('***');
  out = out.replace(/([?&]pwd=)[^&\s"']+/gi, '$1***');
  if (meeting) {
    try {
      const pwd = new URL(meeting).searchParams.get('pwd');
      if (pwd) out = out.split(pwd).join('***');
    } catch {
      /* not a URL, nothing more to scrub */
    }
  }
  return out;
}

export const CREATE_BOT_USAGE = `
node index.js create-bot --meeting <zoom link> --mode zak|obf|guest --user <user_id> [options]

  --meeting <url>     Zoom meeting link, e.g. https://zoom.us/j/123456789?pwd=...
  --mode <mode>       zak   bot joins as the signed-in Zoom user
                      obf   bot joins on behalf of that user, who must already be in the meeting
                      guest no zoom block, plain guest join (for comparison)
  --user <user_id>    Whose Zoom grant to use (the user_id they connected with). Not used for guest.
  --bot-name <name>   Display name in the meeting. Default "MeetStream Notetaker".
  --dry-run           Print the request body (auth redacted) and exit without calling MeetStream.
`.trim();

export function parseCreateBotArgs(argv) {
  const flags = { botName: 'MeetStream Notetaker', dryRun: false };
  const valueFlags = { '--meeting': 'meeting', '--mode': 'mode', '--user': 'user', '--bot-name': 'botName' };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq > 0 ? token.slice(0, eq) : token;
    const key = valueFlags[name];
    if (!key) throw new Error(`Unknown option "${token}".\n\n${CREATE_BOT_USAGE}`);
    const value = eq > 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value.`);
    flags[key] = value;
  }
  return flags;
}

/** Build the `zoom` block for create_bot. Returns undefined for a guest join. */
export function buildZoomBlock({ mode, user, publicBaseUrl, mintSecret }) {
  if (!MODES.has(mode)) throw new Error(`--mode must be zak, obf, or guest. Got "${mode ?? ''}".`);
  if (mode === 'guest') return undefined;

  if (!user || !USER_ID_PATTERN.test(user)) {
    throw new Error('--user is required for zak and obf (letters, digits, . _ @ -).');
  }

  const url = new URL(`${publicBaseUrl}/zoom/${mode}`);
  url.searchParams.set('user_id', user);
  url.searchParams.set('auth', mintSecret);
  const value = url.toString();

  assertPublicHttpsUrl(value, `zoom.${mode}_url`);
  if (value.length > MAX_URL_LENGTH) {
    throw new Error(`zoom.${mode}_url is ${value.length} characters; the API allows at most ${MAX_URL_LENGTH}.`);
  }
  if (url.searchParams.has('meeting_number')) {
    throw new Error('Do not put meeting_number on the token URL. MeetStream appends it at join time.');
  }

  const block = { [`${mode}_url`]: value };
  if (block.zak_url && block.obf_url) {
    throw new Error('Pass only one of zoom.zak_url or zoom.obf_url.');
  }
  return block;
}

const HINTS = [
  [/only one of zoom\.zak_url or zoom\.obf_url/i, 'Send zak_url or obf_url, not both.'],
  [/must use https|must include a host/i, 'PUBLIC_BASE_URL must be your public https tunnel URL, not localhost.'],
  [/use_zoom_obf|zoom_oauth_connection_user_id/i, 'The old hosted-OAuth fields are gone. Use zoom.zak_url or zoom.obf_url.']
];

export async function createBot(config, flags) {
  if (!flags.meeting) throw new Error(`--meeting is required.\n\n${CREATE_BOT_USAGE}`);
  let meetingUrl;
  try {
    meetingUrl = new URL(flags.meeting);
  } catch {
    throw new Error(`--meeting is not a valid URL: "${scrubSecrets(flags.meeting)}"`);
  }
  // Fail fast, before any network call. --dry-run legitimately needs no key.
  if (!flags.dryRun && !config.apiKey) {
    throw new Error(
      'MEETSTREAM_API_KEY is not set. Add it to .env (from https://app.meetstream.ai) or use --dry-run.'
    );
  }
  if (!/(^|\.)zoom\.(us|com)$/i.test(meetingUrl.hostname) && !/zoomgov\.com$/i.test(meetingUrl.hostname)) {
    console.warn(`[warn] ${meetingUrl.hostname} does not look like a Zoom host. zak_url / obf_url only apply to Zoom.`);
  }

  const zoom = buildZoomBlock({
    mode: flags.mode,
    user: flags.user,
    publicBaseUrl: config.publicBaseUrl,
    mintSecret: config.mintSecret
  });

  // Audio only. `video_required: false` is sent explicitly because the REST
  // API treats an omitted `video_required` as true, so leaving it out would
  // silently record video. If you turn video on, also send
  // recording_config.video_layout: "speaker_view" (the API default is
  // grid_view), and never set video_separate_streams unless you asked for
  // per-participant video.
  const body = { meeting_link: flags.meeting, bot_name: flags.botName, video_required: false };
  if (zoom) body.zoom = zoom;

  const printable = {
    ...body,
    meeting_link: scrubSecrets(flags.meeting),
    ...(zoom ? { zoom: Object.fromEntries(Object.entries(zoom).map(([k, v]) => [k, redactUrl(v)])) } : {})
  };
  console.log('create_bot body (auth and pwd redacted):');
  console.log(JSON.stringify(printable, null, 2));

  if (flags.dryRun) {
    console.log('\n--dry-run: not calling MeetStream.');
    return;
  }

  const scrub = (text) => scrubSecrets(text, { mintSecret: config.mintSecret, meeting: flags.meeting });

  let response;
  let data;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(`${config.apiBaseUrl}/bots/create_bot`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Could not reach MeetStream after ${MAX_ATTEMPTS} attempts: ${scrub(cause.message)}`);
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[warn] Could not reach MeetStream (${scrub(cause.message)}). Retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(delay);
      continue;
    }

    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 500) };
    }

    // Transient: 429 and 5xx. Bounded retry with backoff, honouring Retry-After.
    const transient = response.status === 429 || response.status >= 500;
    if (transient && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`[warn] create_bot returned HTTP ${response.status}. Retrying in ${delay}ms (${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(delay);
      continue;
    }
    break;
  }

  // 507 is MeetStream's idempotent replay: the same request already succeeded.
  if (!response.ok && response.status !== 507) {
    const found = data?.message ?? data?.detail ?? data?.error ?? data?.raw;
    // Validation errors can come back as an object of field -> messages.
    const message = !found ? JSON.stringify(data) : typeof found === 'string' ? found : JSON.stringify(found);
    const hint = HINTS.find(([pattern]) => pattern.test(String(message)))?.[1];
    const gaveUp = response.status === 429 || response.status >= 500 ? ` (gave up after ${MAX_ATTEMPTS} attempts)` : '';
    throw new Error(`create_bot returned HTTP ${response.status}${gaveUp}: ${scrub(message)}${hint ? `\n     ${hint}` : ''}`);
  }

  const botId = data?.bot_id || data?.id;
  if (!botId) {
    throw new Error(`create_bot returned HTTP ${response.status} but no bot_id: ${scrub(JSON.stringify(data).slice(0, 500))}`);
  }
  console.log(`\n[ok] HTTP ${response.status}${response.status === 507 ? ' (idempotent replay)' : ''}. bot_id=${botId}`);
  if (zoom) {
    console.log(
      `When the bot joins, it will call ${config.publicBaseUrl}/zoom/${flags.mode}. Watch the token server's log for a [mint] line.`
    );
    if (flags.mode === 'obf') {
      console.log('OBF: the user must already be in the meeting, and the bot leaves when they do.');
    }
  }
}
