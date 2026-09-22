/**
 * list-and-manage-bots
 *
 * Lists every bot on the account with GET /bots, filters and sorts them, prints
 * a table, and can make an active bot leave with GET /bots/{id}/remove_bot.
 *
 *   node index.js
 *   node index.js --status Recording
 *   node index.js --sort status --limit 20
 *   node index.js --remove bot_abc123
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  listAllBots,
  filterByStatus,
  sortBots,
  countByStatus,
  removeBot,
} from "./src/bots.js";
import { printTable, BOT_COLUMNS, botRow } from "./src/table.js";

/** Statuses that mean the bot is still live and can be told to leave. */
const ACTIVE_STATUSES = new Set([
  "Joining",
  "InWaitingRoom",
  "InMeeting",
  "Recording",
  "Leaving",
]);

function parseArgs(argv) {
  const args = { sort: "created", status: null, limit: null, remove: null, json: false, active: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--status":
        args.status = argv[++i];
        break;
      case "--sort":
        args.sort = argv[++i];
        break;
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--remove":
        args.remove = argv[++i];
        break;
      case "--active":
        args.active = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Usage: node index.js [options]

  --status <bot_status>   only show bots in this status (case insensitive)
  --active                only show bots still in a meeting
  --sort <key>            created (default) | status | name | id
  --limit <n>             show at most n rows
  --json                  print the normalised records as JSON
  --remove <bot_id>       make that bot leave the meeting now, then exit
  --help                  this message
`);
}

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("MEETSTREAM_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key from https://app.meetstream.ai");
    process.exit(1);
  }
}

async function doRemove(botId) {
  console.log(`Removing bot ${botId} from its meeting...`);
  console.log("This uses GET /bots/{id}/remove_bot. Recorded data is kept.\n");

  const { status, data } = await removeBot(botId);

  console.log(`HTTP ${status}`);
  if (data) console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  console.log("\nThe bot will report Leaving and then Stopped.");
  console.log("To erase its recordings instead, see the delete-bot-data template.");
}

async function doList(args) {
  console.log("Fetching GET /bots ...\n");

  const { bots, pages } = await listAllBots();

  let view = bots;
  if (args.active) view = view.filter((b) => ACTIVE_STATUSES.has(b.status));
  view = filterByStatus(view, args.status);
  view = sortBots(view, args.sort);
  if (args.limit && Number.isFinite(args.limit)) view = view.slice(0, args.limit);

  if (args.json) {
    console.log(JSON.stringify(view.map(({ raw, ...rest }) => rest), null, 2));
    return;
  }

  if (view.length === 0) {
    console.log("No bots matched.");
    if (bots.length > 0) {
      console.log(`(${bots.length} bots exist on the account, none matched the filter.)`);
    }
    return;
  }

  printTable(BOT_COLUMNS, view.map(botRow));

  console.log(`\n${view.length} of ${bots.length} bots shown, read over ${pages} page(s).`);

  console.log("\nBreakdown by status:");
  for (const [status, count] of countByStatus(bots)) {
    const live = ACTIVE_STATUSES.has(status) ? "  (still in a meeting)" : "";
    console.log(`  ${String(status).padEnd(16)} ${String(count).padStart(4)}${live}`);
  }

  const active = bots.filter((b) => ACTIVE_STATUSES.has(b.status));
  if (active.length > 0) {
    console.log("\nActive bots you can pull out of their meetings:");
    for (const bot of active.slice(0, 10)) {
      console.log(`  node index.js --remove ${bot.id}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireApiKey();

  if (args.remove) {
    await doRemove(args.remove);
    return;
  }

  await doList(args);
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
