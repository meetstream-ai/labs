/**
 * idempotency-and-dedup
 *
 * Runs both anti-duplicate mechanisms against the live API so you can see the
 * difference in the actual status codes:
 *
 *   Idempotency-Key header  retry the same call  -> HTTP 507, original bot
 *   deduplication_key body  replay same booking  -> HTTP 200, original bot
 *   deduplication_key body  different meeting    -> HTTP 409, conflict
 *
 *   node index.js --explain    comparison table, no API calls
 *   node index.js              run the demo
 *   node index.js --no-cleanup leave the created bots in their meetings
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { reportError } from "./src/api.js";
import { createBot, report, tryRemove, printComparison } from "./src/demo.js";

function parseArgs(argv) {
  return {
    explain: argv.includes("--explain"),
    cleanup: !argv.includes("--no-cleanup"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function printUsage() {
  console.log(`
Usage: node index.js [options]

  --explain       print the comparison table and exit (no API key needed)
  --no-cleanup    do not call remove_bot on the bots this demo creates
  --help          this message

The demo creates real bots. By default it removes them from their meetings
when it finishes. It never deletes recorded data.
`);
}

function loadConfig() {
  const missing = [];
  if (!process.env.MEETSTREAM_API_KEY) missing.push("MEETSTREAM_API_KEY");
  if (!process.env.MEETING_LINK) missing.push("MEETING_LINK");

  if (missing.length > 0) {
    console.error(`Missing required config: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values.");
    process.exit(1);
  }

  return {
    meetingLink: process.env.MEETING_LINK,
    // A second, different meeting link. Needed only for the 409 case: reusing
    // one deduplication_key for a different meeting is what triggers it.
    altMeetingLink: process.env.MEETING_LINK_ALT || null,
  };
}

function botBody(meetingLink, name, extra = {}) {
  return {
    meeting_link: meetingLink,
    bot_name: name,
    video_required: false,
    ...extra,
  };
}

async function partOne(config, created) {
  console.log("\n" + "=".repeat(72));
  console.log("PART 1  Idempotency-Key header");
  console.log("=".repeat(72));

  const key = randomUUID();
  const body = botBody(config.meetingLink, "Idempotency Demo Bot");

  console.log(`\nIdempotency-Key: ${key}`);
  console.log("Same key, same body, sent twice.");

  const first = await createBot(body, { idempotencyKey: key });
  report("Attempt 1 (the original call)", first);
  if (first.botId) created.add(first.botId);

  const second = await createBot(body, { idempotencyKey: key });
  const v = report("Attempt 2 (a retry of the same call)", second);
  if (second.botId) created.add(second.botId);

  console.log("\nWhat to take from this:");
  if (second.status === 507) {
    console.log("  507 is the replay signal. It is a SUCCESS, not a failure.");
  } else if (second.status === 200 || second.status === 201) {
    console.log(`  The retry returned ${second.status}.`);
  }
  if (first.botId && second.botId) {
    console.log(
      first.botId === second.botId
        ? `  Same bot_id both times (${first.botId}). One bot, not two.`
        : `  Different bot_ids: ${first.botId} and ${second.botId}.`
    );
  }
  if (!v.ok) {
    console.log("  The retry did not replay as expected. Check the message above.");
  }
}

async function partTwo(config, created) {
  console.log("\n" + "=".repeat(72));
  console.log("PART 2  deduplication_key body field");
  console.log("=".repeat(72));

  // In real code this is a stable id from your own data: a calendar event id,
  // a database row id, anything that identifies the booking rather than the
  // HTTP attempt. Timestamped here so repeated demo runs do not collide.
  const dedupKey = `labs-demo-${Date.now()}`;
  console.log(`\ndeduplication_key: ${dedupKey}`);

  const body = botBody(config.meetingLink, "Dedup Demo Bot", {
    deduplication_key: dedupKey,
  });

  const first = await createBot(body);
  report("Call 1 (first booking)", first);
  if (first.botId) created.add(first.botId);

  const replay = await createBot(body);
  report("Call 2 (same key, same meeting_link)", replay);
  if (replay.botId) created.add(replay.botId);

  if (first.botId && replay.botId) {
    console.log(
      first.botId === replay.botId
        ? `\n  Same bot_id (${first.botId}). The booking was recognised, not repeated.`
        : `\n  Different bot_ids: ${first.botId} and ${replay.botId}.`
    );
  }

  if (!config.altMeetingLink) {
    console.log("\nSkipping the 409 case: MEETING_LINK_ALT is not set.");
    console.log("Set a second, different meeting link in .env to see the conflict.");
    return;
  }

  const wrong = await createBot(
    botBody(config.altMeetingLink, "Dedup Demo Bot", { deduplication_key: dedupKey })
  );
  report("Call 3 (same key, DIFFERENT meeting_link)", wrong);
  if (wrong.botId) created.add(wrong.botId);

  console.log("\nWhat to take from this:");
  if (wrong.status === 409) {
    console.log("  409 means the key is already bound to a different booking.");
    console.log("  Do not retry a 409. Fix the key, or fix the caller that reused it.");
  } else {
    console.log(`  Expected 409 here, got ${wrong.status}.`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }
  if (args.explain) {
    printComparison();
    return;
  }

  const config = loadConfig();
  const created = new Set();

  console.log("This demo creates real bots in your meeting.");
  console.log(`Meeting     : ${config.meetingLink}`);
  console.log(`Alt meeting : ${config.altMeetingLink ?? "(not set, the 409 case will be skipped)"}`);

  try {
    await partOne(config, created);
    await partTwo(config, created);
  } finally {
    if (args.cleanup && created.size > 0) {
      console.log("\n" + "=".repeat(72));
      console.log(`Cleanup: removing ${created.size} bot(s) from their meetings.`);
      console.log("(remove_bot only makes them leave. Recorded data is kept.)");
      for (const botId of created) await tryRemove(botId);
    } else if (created.size > 0) {
      console.log(`\n--no-cleanup, leaving ${created.size} bot(s) in the meeting.`);
    }
  }

  printComparison();
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
