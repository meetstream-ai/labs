/**
 * manage-scheduled-bots
 *
 * Admin CLI for bots that have not joined yet: list them, change the join
 * time, name or attributes, and cancel them.
 *
 *   node index.js list [--limit 50] [--json]
 *   node index.js show <botId>
 *   node index.js reschedule <botId> <iso8601>
 *   node index.js update <botId> [--time <iso>] [--name "New Name"] [--attr k=v]
 *   node index.js cancel <botId> [--yes]
 *   node index.js cancel-all [--yes]
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  listScheduledBots,
  updateScheduledBot,
  deleteScheduledBot,
  getBotStatus,
  parseFutureIso,
  parseAttributes,
} from "./src/bots.js";
import { confirm } from "./src/prompt.js";

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

function parseFlags(argv) {
  const flags = { attrs: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--limit") flags.limit = argv[++i];
    else if (arg === "--time") flags.time = argv[++i];
    else if (arg === "--name") flags.name = argv[++i];
    else if (arg === "--attr") flags.attrs.push(argv[++i]);
    else positional.push(arg);
  }
  return { flags, positional };
}

function pad(value, width) {
  const text = value == null ? "-" : String(value);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function printBotRows(bots) {
  console.log(
    `${pad("JOIN TIME (UTC)", 26)}  ${pad("STATUS", 12)}  ${pad("PLATFORM", 10)}  ` +
      `${pad("BOT ID", 24)}  NAME`
  );
  console.log(`${"-".repeat(26)}  ${"-".repeat(12)}  ${"-".repeat(10)}  ${"-".repeat(24)}  ${"-".repeat(24)}`);
  for (const bot of bots) {
    console.log(
      `${pad(bot.scheduled_join_time, 26)}  ${pad(bot.status, 12)}  ${pad(bot.platform, 10)}  ` +
        `${pad(bot.bot_id, 24)}  ${bot.bot_username ?? "-"}`
    );
  }
}

async function cmdList(flags) {
  const bots = await listScheduledBots(flags.limit ?? process.env.LIST_LIMIT ?? 100);

  if (flags.json) {
    console.log(JSON.stringify(bots, null, 2));
    return;
  }

  if (!bots.length) {
    console.log("No bots are scheduled to join a future meeting.");
    console.log("Schedule one with the calendar-schedule-bot or calendar-auto-schedule template.");
    return;
  }

  bots.sort((a, b) => String(a.scheduled_join_time).localeCompare(String(b.scheduled_join_time)));

  console.log("");
  printBotRows(bots);
  console.log(`\n${bots.length} scheduled bot(s).`);
  if (bots.length === 100) {
    console.log("(100 is the API maximum for one page, there may be more.)");
  }
}

async function cmdShow(botId) {
  if (!botId) {
    console.error("\nUsage: node index.js show <botId>");
    process.exit(1);
  }

  const bots = await listScheduledBots(100);
  const bot = bots.find((b) => b.bot_id === botId);

  if (!bot) {
    console.log(`${botId} is not in the scheduled list.`);
    console.log("It may have already joined, been cancelled, or sit past the 100 bot page limit.");
  } else {
    console.log(`Bot ${bot.bot_id}`);
    console.log(`  Scheduled join : ${bot.scheduled_join_time ?? "-"}`);
    console.log(`  Status         : ${bot.status ?? "-"}`);
    console.log(`  Platform       : ${bot.platform ?? "-"}`);
    console.log(`  Display name   : ${bot.bot_username ?? "-"}`);
    console.log(`  Meeting link   : ${bot.meeting_link ?? "-"}`);
    if (bot.custom_attributes && Object.keys(bot.custom_attributes).length) {
      console.log("  Custom attrs   :");
      for (const [key, value] of Object.entries(bot.custom_attributes)) {
        console.log(`    ${key} = ${value}`);
      }
    }
  }

  // Live status is authoritative once the bot starts moving through its
  // lifecycle, so show it alongside the scheduling record.
  const status = await getBotStatus(botId);
  if (status) {
    console.log(`\nLive status (GET /bots/${botId}/status): ${status.status ?? JSON.stringify(status)}`);
  }
}

async function cmdReschedule(botId, iso) {
  if (!botId || !iso) {
    console.error("\nUsage: node index.js reschedule <botId> <iso8601>");
    console.error("Example: node index.js reschedule bot_111aaa12 2026-04-22T15:00:00Z");
    process.exit(1);
  }

  const scheduledJoinTime = parseFutureIso(iso);
  console.log(`Rescheduling ${botId} to ${scheduledJoinTime} ...`);

  const data = await updateScheduledBot(botId, { scheduled_join_time: scheduledJoinTime });
  printUpdateResult(data);
}

function printUpdateResult(data) {
  console.log("\nUpdated.");
  if (data.message) console.log(`  ${data.message}`);
  if (data.bot_id) console.log(`  Bot id         : ${data.bot_id}`);
  if (Array.isArray(data.updated_fields)) {
    console.log(`  Updated fields : ${data.updated_fields.join(", ") || "(none reported)"}`);
  }
  if (data.schedule_updated != null) console.log(`  Schedule moved : ${data.schedule_updated}`);
}

async function cmdUpdate(botId, flags) {
  if (!botId) {
    console.error('\nUsage: node index.js update <botId> [--time <iso>] [--name "New Name"] [--attr k=v]');
    process.exit(1);
  }

  const patch = {};
  if (flags.time) patch.scheduled_join_time = parseFutureIso(flags.time);
  if (flags.name) patch.bot_username = flags.name;
  if (flags.attrs.length) patch.custom_attributes = parseAttributes(flags.attrs);

  if (!Object.keys(patch).length) {
    console.error("\nNothing to update. Pass at least one of --time, --name, --attr.");
    process.exit(1);
  }

  if (!patch.scheduled_join_time) {
    // The published request schema marks scheduled_join_time as required even
    // though the guide describes every field as optional. Warn rather than
    // block, and let the API be the judge.
    console.log("Note: sending a partial update with no --time.");
    console.log("The published schema marks scheduled_join_time required, so this may 400.");
  }

  console.log(`Updating ${botId} with:`);
  console.log(JSON.stringify(patch, null, 2));

  const data = await updateScheduledBot(botId, patch);
  printUpdateResult(data);
}

async function cmdCancel(botId, flags) {
  if (!botId) {
    console.error("\nUsage: node index.js cancel <botId> [--yes]");
    process.exit(1);
  }

  const bots = await listScheduledBots(100);
  const bot = bots.find((b) => b.bot_id === botId);

  console.log(`About to cancel scheduled bot ${botId}`);
  if (bot) {
    console.log(`  Joins at    : ${bot.scheduled_join_time ?? "-"}`);
    console.log(`  Meeting link: ${bot.meeting_link ?? "-"}`);
    console.log(`  Name        : ${bot.bot_username ?? "-"}`);
  } else {
    console.log("  (not found in the scheduled list, sending the delete anyway)");
  }

  if (!flags.yes && !(await confirm("\nThis cannot be undone."))) {
    console.log("Cancelled. No changes made.");
    return;
  }

  const data = await deleteScheduledBot(botId);
  console.log("\nDeleted.");
  if (data.message) console.log(`  ${data.message}`);
  if (data.bot_id) console.log(`  Bot id: ${data.bot_id}`);
}

async function cmdCancelAll(flags) {
  const bots = await listScheduledBots(100);

  if (!bots.length) {
    console.log("Nothing scheduled. Nothing to cancel.");
    return;
  }

  console.log(`About to cancel ${bots.length} scheduled bot(s):\n`);
  printBotRows(bots);

  if (!flags.yes && !(await confirm("\nThis cannot be undone.", "cancel all"))) {
    console.log("Aborted. No changes made.");
    return;
  }

  let deleted = 0;
  const failures = [];

  for (const bot of bots) {
    try {
      await deleteScheduledBot(bot.bot_id);
      deleted += 1;
      console.log(`  deleted ${bot.bot_id}`);
    } catch (err) {
      // Keep going: one bot that already started should not block the rest.
      failures.push({ botId: bot.bot_id, message: err.message });
      console.log(`  FAILED  ${bot.bot_id}: ${err.message}`);
    }
  }

  console.log(`\n${deleted} deleted, ${failures.length} failed.`);
  if (failures.length) process.exitCode = 1;
}

async function main() {
  requireApiKey();

  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [command, arg1, arg2] = positional;

  switch (command ?? "list") {
    case "list":
      await cmdList(flags);
      break;
    case "show":
      await cmdShow(arg1);
      break;
    case "reschedule":
      await cmdReschedule(arg1, arg2);
      break;
    case "update":
      await cmdUpdate(arg1, flags);
      break;
    case "cancel":
      await cmdCancel(arg1, flags);
      break;
    case "cancel-all":
      await cmdCancelAll(flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node index.js [list|show|reschedule|update|cancel|cancel-all] ...");
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
