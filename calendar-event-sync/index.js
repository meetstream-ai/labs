/**
 * calendar-event-sync
 *
 * Syncs upcoming events from a connected calendar, works out which ones have
 * a joinable meeting link, and prints a schedule table.
 *
 *   node index.js
 *   node index.js --days 14 --limit 50
 *   node index.js --with-links          only events a bot could join
 *   node index.js --json                raw JSON instead of the table
 *
 * Connect a calendar first with the google-calendar-integration or
 * outlook-calendar-integration template.
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  fetchAllEvents,
  detectPlatform,
  hasMeetingLink,
  eventTitle,
  scheduledBots,
} from "./src/events.js";
import { renderTable, formatStart } from "./src/table.js";

function parseArgs(argv) {
  const args = { json: false, withLinks: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--with-links") args.withLinks = true;
    else if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--calendar-id") args.calendarId = argv[++i];
    else if (arg === "--provider") args.provider = argv[++i];
    else if (arg === "--account-id") args.accountId = argv[++i];
    else if (arg === "--no-sync") args.sync = "false";
  }
  return args;
}

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

async function main() {
  requireApiKey();
  const args = parseArgs(process.argv.slice(2));

  const days = args.days ?? Number(process.env.SYNC_DAYS_AHEAD || 14);
  const limit = args.limit ?? Number(process.env.SYNC_PAGE_SIZE || 50);
  const maxEvents = Number(process.env.SYNC_MAX_EVENTS || 200);

  const now = new Date();
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  console.log(`Syncing events for the next ${days} day(s)...`);

  const events = await fetchAllEvents(
    {
      time_min: now.toISOString(),
      time_max: timeMax.toISOString(),
      limit: Math.min(Math.max(limit, 1), 100),
      sync: args.sync,
      calendar_id: args.calendarId || process.env.CALENDAR_ID,
      provider: args.provider || process.env.CALENDAR_PROVIDER,
      account_id: args.accountId || process.env.CALENDAR_ACCOUNT_ID,
    },
    maxEvents
  );

  // Events deleted upstream can still come back in a sync page. Drop them.
  const live = events.filter((e) => !e.is_deleted);
  const joinable = live.filter(hasMeetingLink);
  const shown = args.withLinks ? joinable : live;

  if (args.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  if (shown.length === 0) {
    console.log("\nNo events in that window.");
    console.log("If you expected some, check that a calendar is connected (GET /calendar)");
    console.log("and widen the window with --days 30.");
    return;
  }

  shown.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

  const rows = shown.map((event) => {
    const bots = scheduledBots(event);
    return {
      start: formatStart(event.start_time),
      platform: detectPlatform(event) ?? "no link",
      bot: bots.length ? bots[0].status || "scheduled" : "-",
      event_id: event.id,
      title: eventTitle(event),
    };
  });

  console.log("");
  console.log(
    renderTable(
      [
        { key: "start", label: "START", width: 16 },
        { key: "platform", label: "PLATFORM", width: 15 },
        { key: "bot", label: "BOT", width: 10 },
        { key: "event_id", label: "EVENT ID", width: 22 },
        { key: "title", label: "TITLE", width: 40 },
      ],
      rows
    )
  );

  const withBots = live.filter((e) => scheduledBots(e).length > 0).length;
  console.log("");
  console.log(`${live.length} event(s) synced`);
  console.log(`${joinable.length} with a joinable meeting link`);
  console.log(`${live.length - joinable.length} without a link (a bot cannot join these)`);
  console.log(`${withBots} already have a bot scheduled`);

  const next = joinable.find((e) => scheduledBots(e).length === 0);
  if (next) {
    console.log("");
    console.log("To put a bot on the next unscheduled meeting, use the");
    console.log(`calendar-schedule-bot template with EVENT_ID=${next.id}`);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
