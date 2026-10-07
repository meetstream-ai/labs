/**
 * Argument parsing and schedule building.
 */

import { readFileSync } from "node:fs";

export const USAGE = `
send-chat-message: post chat messages into a live meeting as your bot

  One message, right now (bot is already in the meeting):
    node index.js --bot-id <id> --message "Recording has started"

  One message, N seconds from now:
    node index.js --bot-id <id> --message "Five minutes left" --after 300

  Create a bot, wait for it to join, then run a timed announcement plan.
  Offsets are seconds after the bot reaches the meeting:
    node index.js --meeting-link https://meet.google.com/abc-defg-hij \\
      --announce "0:Hi everyone, I am recording this session|300:Halfway|600:Wrapping up"

  Same thing from a file:
    node index.js --meeting-link <url> --schedule-file schedule.json

Options
  --bot-id <id>            Existing bot to talk through
  --meeting-link <url>     Create a new bot for this meeting instead
  --bot-name <name>        Display name for a newly created bot
  --message, -m <text>     A single message to send
  --after <seconds>        Delay before sending --message (default 0)
  --announce <spec>        Pipe-separated "seconds:text" entries
  --schedule-file <path>   JSON array of { "after_seconds": <n>, "message": "..." }
  --wait-timeout <seconds> How long to wait for the bot to join (default 600)
  --stay                   Leave a bot we created in the meeting when done
  --dry-run                Print the plan without calling the API
  -h, --help               This text

Exactly one of --bot-id or --meeting-link is required, and at least one of
--message, --announce or --schedule-file.
`;

export function parseArgs(argv) {
  const opts = {
    botId: null,
    meetingLink: null,
    botName: process.env.BOT_NAME || "MeetStream Labs Announcer",
    message: null,
    after: 0,
    announce: null,
    scheduleFile: null,
    waitTimeout: Number.parseInt(process.env.WAIT_TIMEOUT_SECONDS ?? "600", 10),
    stay: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };

    switch (arg) {
      case "--bot-id":        opts.botId = value(); break;
      case "--meeting-link":  opts.meetingLink = value(); break;
      case "--bot-name":      opts.botName = value(); break;
      case "--message":
      case "-m":              opts.message = value(); break;
      case "--after":         opts.after = requireNumber(arg, value()); break;
      case "--announce":      opts.announce = value(); break;
      case "--schedule-file": opts.scheduleFile = value(); break;
      case "--wait-timeout":  opts.waitTimeout = requireNumber(arg, value()); break;
      case "--stay":          opts.stay = true; break;
      case "--dry-run":       opts.dryRun = true; break;
      case "-h":
      case "--help":          opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function requireNumber(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative number (got "${raw}")`);
  return n;
}

/**
 * Build the ordered list of { afterSeconds, message } to send.
 * Offsets are relative to the moment the bot is confirmed in the meeting.
 */
export function buildSchedule(opts) {
  const entries = [];

  if (opts.message) {
    entries.push({ afterSeconds: opts.after, message: opts.message });
  }

  if (opts.announce) {
    for (const raw of opts.announce.split("|")) {
      const part = raw.trim();
      if (!part) continue;
      const split = part.indexOf(":");
      if (split === -1) {
        throw new Error(`Bad --announce entry "${part}": expected "seconds:message"`);
      }
      const seconds = Number(part.slice(0, split));
      const message = part.slice(split + 1).trim();
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Bad offset in --announce entry "${part}"`);
      }
      if (!message) throw new Error(`Empty message in --announce entry "${part}"`);
      entries.push({ afterSeconds: seconds, message });
    }
  }

  if (opts.scheduleFile) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(opts.scheduleFile, "utf8"));
    } catch (err) {
      throw new Error(`Could not read ${opts.scheduleFile}: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${opts.scheduleFile} must contain a JSON array`);
    }
    for (const item of parsed) {
      const seconds = Number(item?.after_seconds ?? item?.afterSeconds);
      const message = item?.message;
      if (!Number.isFinite(seconds) || seconds < 0 || typeof message !== "string" || !message.trim()) {
        throw new Error(
          `Bad entry in ${opts.scheduleFile}: ${JSON.stringify(item)} ` +
          '; expected { "after_seconds": <number>, "message": "<text>" }'
        );
      }
      entries.push({ afterSeconds: seconds, message: message.trim() });
    }
  }

  return entries.sort((a, b) => a.afterSeconds - b.afterSeconds);
}

export function validate(opts, schedule) {
  if (Boolean(opts.botId) === Boolean(opts.meetingLink)) {
    throw new Error("Provide exactly one of --bot-id or --meeting-link.");
  }
  if (schedule.length === 0) {
    throw new Error("Nothing to send. Use --message, --announce or --schedule-file.");
  }
}
