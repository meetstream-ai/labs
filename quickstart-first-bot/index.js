/**
 * quickstart-first-bot
 *
 * The smallest useful MeetStream program:
 *   1. POST /bots/create_bot  to send a bot into a meeting
 *   2. GET  /bots/{id}/status in a loop until the bot reaches a terminal state
 *   3. print what happened
 */

import "dotenv/config";
import { call, reportError, sleep } from "./src/api.js";

/**
 * Terminal bot_status values. Once the bot reports one of these it will not
 * change again, so polling can stop.
 *
 *   Stopped    the bot left normally
 *   Done       the session finished and post-processing completed
 *   NotAllowed the bot timed out in the waiting room
 *   Denied     the host denied the bot entry
 *   Error      the session failed
 */
const TERMINAL_STATUSES = new Set([
  "Stopped",
  "Done",
  "NotAllowed",
  "Denied",
  "Error",
]);

/** The states a healthy session moves through before it terminates. */
const IN_FLIGHT_STATUSES = [
  "Joining",
  "InWaitingRoom",
  "InMeeting",
  "Recording",
  "Leaving",
];

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 240; // 240 x 5s = 20 minutes

function loadConfig() {
  const apiKey = process.env.MEETSTREAM_API_KEY;
  const meetingLink = process.env.MEETING_LINK;

  const missing = [];
  if (!apiKey) missing.push("MEETSTREAM_API_KEY");
  if (!meetingLink) missing.push("MEETING_LINK");

  if (missing.length > 0) {
    console.error(`Missing required config: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values.");
    console.error("Get an API key at https://app.meetstream.ai");
    process.exit(1);
  }

  return {
    meetingLink,
    botName: process.env.BOT_NAME || "Quickstart Bot",
    videoRequired: String(process.env.VIDEO_REQUIRED || "false") === "true",
  };
}

/** Sends the bot into the meeting. Returns the create response body. */
async function createBot({ meetingLink, botName, videoRequired }) {
  console.log("Creating bot...");
  console.log(`  meeting_link : ${meetingLink}`);
  console.log(`  bot_name     : ${botName}`);
  console.log(`  video        : ${videoRequired ? "on" : "off (audio only)"}\n`);

  const { status, data } = await call("/bots/create_bot", {
    method: "POST",
    body: {
      meeting_link: meetingLink,
      bot_name: botName,
      video_required: videoRequired,
    },
  });

  console.log(`Bot created (HTTP ${status})`);
  console.log(`  bot_id        : ${data?.bot_id}`);
  console.log(`  transcript_id : ${data?.transcript_id ?? "(none, no transcription provider set)"}`);
  console.log(`  status        : ${data?.status ?? "(not reported yet)"}\n`);

  if (!data?.bot_id) {
    throw new Error("The API did not return a bot_id. Full response:\n" + JSON.stringify(data, null, 2));
  }

  return data;
}

/**
 * GET /bots/{id}/status
 *
 * The endpoint reports the current bot_status. Different accounts have seen it
 * keyed as `bot_status` or `status`, so normalise defensively rather than
 * assuming one shape.
 */
async function readStatus(botId) {
  const { data } = await call(`/bots/${botId}/status`);
  if (typeof data === "string") return data.trim();
  return data?.bot_status ?? data?.status ?? data?.state ?? "Unknown";
}

/** Polls until the bot reaches a terminal state or the poll budget runs out. */
async function waitForTerminal(botId) {
  console.log("Polling GET /bots/{id}/status every 5s. Ctrl+C to stop.");
  console.log(`Expected path: ${IN_FLIGHT_STATUSES.join(" > ")} > terminal\n`);

  let last = null;

  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    const status = await readStatus(botId);

    if (status !== last) {
      const stamp = new Date().toLocaleTimeString();
      console.log(`[${stamp}] ${status}`);
      last = status;
    }

    if (TERMINAL_STATUSES.has(status)) return status;

    await sleep(POLL_INTERVAL_MS);
  }

  console.log(
    `\nGave up after ${MAX_POLLS} polls (~${(MAX_POLLS * POLL_INTERVAL_MS) / 60000} minutes).`
  );
  console.log(`The bot may still be running. Check it later with bot_id ${botId}.`);
  return null;
}

function explain(status) {
  switch (status) {
    case "Stopped":
      return "The bot left the meeting normally.";
    case "Done":
      return "The session finished and post-processing is complete.";
    case "NotAllowed":
      return "Nobody admitted the bot from the waiting room before the timeout.";
    case "Denied":
      return "The host explicitly denied the bot.";
    case "Error":
      return "The session failed. Check GET /bots/{id}/detail for the reason.";
    default:
      return "Unrecognised terminal status.";
  }
}

async function main() {
  const config = loadConfig();

  const bot = await createBot(config);
  const finalStatus = await waitForTerminal(bot.bot_id);

  if (finalStatus) {
    console.log(`\nFinal status: ${finalStatus}`);
    console.log(explain(finalStatus));
  }

  console.log("\nNext steps:");
  console.log(`  GET /bots/${bot.bot_id}/detail       full session metadata`);
  console.log(`  GET /bots/${bot.bot_id}/get_audio    the recording`);
  console.log("  See the bot-status-monitor template for a live lifecycle view.");
  console.log("  See the post-call-transcription template to get a transcript.");
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
