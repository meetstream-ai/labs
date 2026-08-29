/**
 * bot-status-monitor
 *
 * Polls GET /bots/{id}/status and GET /bots/{id}/detail and draws the bot
 * lifecycle as a live timeline in the terminal.
 *
 *   node index.js                 monitor BOT_ID, or create a bot from MEETING_LINK
 *   node index.js <bot_id>        monitor a specific bot
 *   node index.js --explain       print the bot_status reference and exit
 *   node index.js <bot_id> --raw  dump the raw detail payload at the end
 */

import "dotenv/config";
import { call, reportError, sleep } from "./src/api.js";
import { isTerminal, printReference, describe } from "./src/statuses.js";
import { Timeline } from "./src/timeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const MAX_POLLS = Number(process.env.MAX_POLLS || 400);
/** Detail is heavier than status, so refresh it less often. */
const DETAIL_EVERY_N_POLLS = 10;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return {
    botId: positional[0] ?? process.env.BOT_ID ?? null,
    explain: flags.has("--explain"),
    raw: flags.has("--raw"),
  };
}

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("MEETSTREAM_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key from https://app.meetstream.ai");
    process.exit(1);
  }
}

/** Only used when no bot_id was supplied, so the template is runnable cold. */
async function createBot(meetingLink) {
  console.log(`No BOT_ID given. Creating a bot for ${meetingLink}\n`);

  const { data } = await call("/bots/create_bot", {
    method: "POST",
    body: {
      meeting_link: meetingLink,
      bot_name: process.env.BOT_NAME || "Status Monitor Bot",
      video_required: false,
    },
  });

  if (!data?.bot_id) {
    throw new Error("create_bot did not return a bot_id:\n" + JSON.stringify(data, null, 2));
  }

  console.log(`Created bot ${data.bot_id}\n`);
  return data.bot_id;
}

/** Normalises the status endpoint response into a bare status string. */
async function readStatus(botId) {
  const { data } = await call(`/bots/${botId}/status`);
  if (typeof data === "string") return data.trim();
  return data?.bot_status ?? data?.status ?? data?.state ?? "Unknown";
}

/**
 * Detail can legitimately 404 for a few seconds right after creation, and it
 * is only decoration for this view, so never let it kill the monitor.
 */
async function readDetail(botId) {
  try {
    const { status, data } = await call(`/bots/${botId}/detail`, { accept: [202, 404] });
    if (status === 202 || status === 404) return null;
    return data;
  } catch {
    return null;
  }
}

async function monitor(botId, { raw }) {
  const timeline = new Timeline(botId);

  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    const status = await readStatus(botId);
    const changed = timeline.record(status);

    if (changed || poll % DETAIL_EVERY_N_POLLS === 1) {
      timeline.setDetail(await readDetail(botId));
    }

    timeline.render();

    if (isTerminal(status)) {
      timeline.setDetail(await readDetail(botId));
      timeline.renderSummary();

      const info = describe(status);
      console.log(`Final bot_status: ${status}`);
      if (info) console.log(info.meaning);

      if (raw) {
        console.log("\nRaw detail payload:");
        console.log(JSON.stringify(await readDetail(botId), null, 2));
      }
      return status;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  timeline.renderSummary();
  console.log(
    `Poll budget exhausted after ${MAX_POLLS} polls. The bot may still be running.`
  );
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.explain) {
    printReference();
    return;
  }

  requireApiKey();

  let botId = args.botId;
  if (!botId) {
    const meetingLink = process.env.MEETING_LINK;
    if (!meetingLink) {
      console.error("Give a bot id, or set BOT_ID, or set MEETING_LINK to create one.");
      console.error("  node index.js <bot_id>");
      console.error("  node index.js --explain    (no API key needed)");
      process.exit(1);
    }
    botId = await createBot(meetingLink);
  }

  await monitor(botId, args);
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
