#!/usr/bin/env node
/**
 * MeetStream Labs: Send Chat Message
 * ===================================
 * A CLI for posting chat messages into a live meeting as your bot, either
 * immediately or on a timed announcement plan.
 *
 *   node index.js --bot-id <id> --message "Recording has started"
 *   node index.js --meeting-link <url> --announce "0:Hi everyone|300:Halfway"
 *
 * The one API call underneath is:
 *
 *   POST /bots/{bot_id}/send_message
 *   { "message": "..." }
 *
 * Everything else here is scheduling: creating a bot if you did not supply one,
 * polling GET /bots/{bot_id}/status until it is actually in the meeting, then
 * firing each message at its offset.
 */

import "dotenv/config";
import { log, c } from "./src/logger.js";
import { MeetStreamClient, MeetStreamError } from "./src/meetstream.js";
import { parseArgs, buildSchedule, validate, USAGE } from "./src/cli.js";
import { waitForInMeeting, runSchedule } from "./src/announcer.js";

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const schedule = buildSchedule(opts);
  validate(opts, schedule);

  log.banner("MeetStream Labs: Send Chat Message", "POST /bots/{id}/send_message");

  log.info(`Plan (${schedule.length} message${schedule.length === 1 ? "" : "s"}):`);
  for (const entry of schedule) {
    log.detail(`t+${String(entry.afterSeconds).padStart(5)}s  ${entry.message}`);
  }

  if (opts.dryRun) {
    log.warn("--dry-run: no API calls made.");
    return;
  }

  if (!process.env.MEETSTREAM_API_KEY) {
    throw new Error("Missing MEETSTREAM_API_KEY. Copy .env.example to .env and fill it in.");
  }

  const client = new MeetStreamClient(process.env.MEETSTREAM_API_KEY, { logger: log });

  let botId = opts.botId;
  let weCreatedTheBot = false;

  if (!botId) {
    log.info(`Creating a bot for ${opts.meetingLink} …`);
    const bot = await client.createBot({
      meeting_link: opts.meetingLink,
      bot_name: opts.botName,
      video_required: false,
      automatic_leave: {
        waiting_room_timeout: 600,
        everyone_left_timeout: 60,
        in_call_recording_timeout: 14400, // minimum accepted value is 600
      },
    });
    botId = bot.bot_id;
    weCreatedTheBot = true;
    log.success(`Bot created: ${c("bold", botId)} (status: ${bot.status})`);
  }

  // Removing our own bot on Ctrl+C, so an interrupted run does not leave it
  // sitting silently in someone's meeting.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("");
    log.warn("Interrupted: cleaning up…");
    const done = () => process.exit(130);
    if (weCreatedTheBot) {
      client.removeBot(botId).then(done, (err) => {
        log.error("removeBot failed", err);
        done();
      });
    } else {
      done();
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  log.info("Waiting for the bot to be in the meeting…");
  const status = await waitForInMeeting(client, botId, { timeoutSeconds: opts.waitTimeout });
  log.success(`Bot is live (${status}). Starting the announcement plan.`);
  console.log("");

  const { sent, failed } = await runSchedule(client, botId, schedule);

  console.log("");
  log.success(`Done: ${sent} sent, ${failed} failed.`);

  if (weCreatedTheBot && !opts.stay) {
    await client.removeBot(botId);
    log.info(`Bot ${botId} removed from the meeting.`);
  } else if (weCreatedTheBot) {
    log.warn(`Bot ${botId} is still in the meeting (--stay).`);
    log.detail(`Remove it later with: GET /bots/${botId}/remove_bot`);
  }
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    log.error(`MeetStream API ${err.status} on ${err.path}: ${err.message}`);
    if (err.hint) log.detail(err.hint);
  } else {
    log.error(err.message);
    if (/Unknown option|requires a value|exactly one of|Nothing to send/i.test(err.message)) {
      console.log(USAGE);
    }
  }
  process.exit(1);
});
