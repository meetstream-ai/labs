/**
 * scheduled-bot-join-at
 *
 * The full lifecycle of a scheduled bot:
 *   create      POST   /bots/create_bot            with a future join_at
 *   list        GET    /bots                       filtered to scheduled bots
 *   reschedule  PATCH  /calendar/scheduled_bots/{bot_id}
 *   cancel      DELETE /calendar/scheduled_bots/{bot_id}
 *
 *   node index.js create --in 30
 *   node index.js create --at 2026-07-02T15:00:00Z
 *   node index.js list
 *   node index.js reschedule <bot_id> --in 90
 *   node index.js cancel <bot_id>
 */

import "dotenv/config";
import { call, reportError } from "./src/api.js";
import {
  resolveJoinAt,
  warnIfPast,
  untilText,
  listBots,
  scheduledBots,
  reschedule,
  cancel,
} from "./src/schedule.js";

function parseArgs(argv) {
  const args = { command: null, botId: null, inMinutes: null, at: null, all: false };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--in") args.inMinutes = Number(argv[++i]);
    else if (arg === "--at") args.at = argv[++i];
    else if (arg === "--all") args.all = true;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else if (arg.startsWith("--")) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    } else positional.push(arg);
  }

  args.command = args.command ?? positional[0] ?? "help";
  args.botId = positional[1] ?? process.env.BOT_ID ?? null;
  return args;
}

function printUsage() {
  console.log(`
Usage: node index.js <command> [options]

  create                      schedule a bot
    --in <minutes>              relative, e.g. --in 30
    --at <iso timestamp>        absolute, e.g. --at 2026-07-02T15:00:00Z

  list                        show scheduled bots
    --all                       include past join_at times too

  reschedule <bot_id> --in 90        move a scheduled bot
  reschedule <bot_id> --at <iso>

  cancel <bot_id>             cancel a scheduled bot before it joins
`);
}

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("MEETSTREAM_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key from https://app.meetstream.ai");
    process.exit(1);
  }
}

async function doCreate(args) {
  const meetingLink = process.env.MEETING_LINK;
  if (!meetingLink) {
    console.error("MEETING_LINK is not set. Add it to .env.");
    process.exit(1);
  }

  const joinAt = resolveJoinAt(args);
  warnIfPast(joinAt);

  const body = {
    meeting_link: meetingLink,
    bot_name: process.env.BOT_NAME || "Scheduled Bot",
    video_required: String(process.env.VIDEO_REQUIRED || "false") === "true",
    join_at: joinAt,
  };

  console.log("POST /bots/create_bot");
  console.log(JSON.stringify(body, null, 2));

  const { status, data } = await call("/bots/create_bot", { method: "POST", body });

  console.log(`\nScheduled (HTTP ${status})`);
  console.log(`  bot_id  : ${data?.bot_id}`);
  console.log(`  join_at : ${joinAt}  (${untilText(joinAt)})`);
  console.log(`  status  : ${data?.status ?? "(not reported yet)"}`);
  console.log("\nThe bot sits idle until join_at, then runs the normal lifecycle:");
  console.log("  Joining > InWaitingRoom > InMeeting > Recording > Leaving > Stopped");
  console.log("\nManage it with:");
  console.log(`  node index.js reschedule ${data?.bot_id} --in 90`);
  console.log(`  node index.js cancel ${data?.bot_id}`);
}

async function doList(args) {
  console.log("GET /bots ...\n");

  const bots = await listBots();
  const scheduled = scheduledBots(bots, { upcomingOnly: !args.all });

  if (scheduled.length === 0) {
    console.log(
      args.all
        ? "No bots on the account carry a join_at."
        : "No upcoming scheduled bots. Use --all to include past join_at times."
    );
    console.log(`(${bots.length} bots total on the account.)`);
    return;
  }

  console.log(`${scheduled.length} scheduled bot(s):\n`);
  for (const bot of scheduled) {
    console.log(`  ${bot.id}`);
    console.log(`    join_at : ${bot.joinAt}  (${untilText(bot.joinAt)})`);
    console.log(`    status  : ${bot.status}`);
    console.log(`    name    : ${bot.name ?? "-"}`);
    console.log(`    meeting : ${bot.meeting ?? "-"}`);
    console.log("");
  }

  console.log("There is no dedicated list-scheduled endpoint. This reads GET /bots");
  console.log("and keeps the records that carry a join_at.");
}

async function doReschedule(args) {
  if (!args.botId) {
    console.error("reschedule needs a bot id: node index.js reschedule <bot_id> --in 90");
    process.exit(1);
  }

  const joinAt = resolveJoinAt(args);
  warnIfPast(joinAt);

  console.log(`PATCH /calendar/scheduled_bots/${args.botId}`);
  console.log(JSON.stringify({ join_at: joinAt }, null, 2));

  const { status, data } = await reschedule(args.botId, joinAt);

  console.log(`\nRescheduled (HTTP ${status})`);
  console.log(`  join_at : ${joinAt}  (${untilText(joinAt)})`);
  if (data) console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log("\nConfirm with: node index.js list");
}

async function doCancel(args) {
  if (!args.botId) {
    console.error("cancel needs a bot id: node index.js cancel <bot_id>");
    process.exit(1);
  }

  console.log(`DELETE /calendar/scheduled_bots/${args.botId}`);

  const { status, data } = await cancel(args.botId);

  console.log(`\nCancelled (HTTP ${status})`);
  if (data) console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log("\nThe bot will not join. This only works before join_at.");
  console.log("For a bot already in a meeting use GET /bots/{id}/remove_bot instead.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printUsage();
    return;
  }

  requireApiKey();

  switch (args.command) {
    case "create":
      return doCreate(args);
    case "list":
      return doList(args);
    case "reschedule":
      return doReschedule(args);
    case "cancel":
      return doCancel(args);
    default:
      console.error(`Unknown command: ${args.command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
