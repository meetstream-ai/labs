/**
 * calendar-disconnect
 *
 * Tears down a calendar integration with POST /calendar/disconnect. This is
 * destructive and irreversible, so the template shows exactly what will be
 * removed and requires a typed confirmation first.
 *
 *   node index.js preview                       show what a disconnect would remove
 *   node index.js disconnect [--yes]            disconnect
 *   node index.js disconnect --provider outlook
 *   node index.js disconnect --provider outlook --account-id jane@acme.com
 *   node index.js disconnect --keep-events      keep the historical event rows
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  safeListCalendars,
  safeListConnections,
  safeListScheduledBots,
  safeCountEvents,
  buildDisconnectBody,
  disconnectCalendar,
} from "./src/disconnect.js";
import { confirm } from "./src/prompt.js";

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--keep-events") flags.keepEvents = true;
    else if (arg === "--provider") flags.provider = argv[++i];
    else if (arg === "--account-id") flags.accountId = argv[++i];
    else positional.push(arg);
  }
  return { flags, positional };
}

/** Gathers and prints everything a disconnect would destroy. */
async function preview() {
  console.log("Checking what is currently connected...\n");

  const connections = await safeListConnections();
  const calendars = await safeListCalendars();
  const bots = await safeListScheduledBots();
  const events = await safeCountEvents();

  let connectionCount = null;

  if (connections) {
    const google = Array.isArray(connections.google) ? connections.google : [];
    const outlook = Array.isArray(connections.outlook) ? connections.outlook : [];
    connectionCount = connections.total ?? google.length + outlook.length;

    console.log(`Connections: ${connectionCount}`);
    for (const conn of google) console.log(`  - [google]  ${conn.account_id ?? conn.email ?? "?"}`);
    for (const conn of outlook) console.log(`  - [outlook] ${conn.account_id ?? conn.email ?? "?"}`);
  } else {
    console.log("Connections: none readable (GET /calendar returned nothing).");
  }

  if (calendars) {
    const list = Array.isArray(calendars.calendars) ? calendars.calendars : [];
    console.log(`\nCalendars  : ${calendars.total ?? list.length}`);
    for (const cal of list.slice(0, 10)) {
      console.log(`  - ${cal.summary || cal.id}${cal.isPrimary ? "  (primary)" : ""}`);
    }
    if (list.length > 10) console.log(`  ... and ${list.length - 10} more`);
  } else {
    console.log("\nCalendars  : none readable. There may be nothing connected.");
  }

  if (bots) {
    console.log(`\nScheduled bots: ${bots.length}${bots.length === 100 ? "+ (page limit)" : ""}`);
    for (const bot of bots.slice(0, 10)) {
      console.log(`  - ${bot.scheduled_join_time ?? "?"}  ${bot.bot_id}  ${bot.bot_username ?? ""}`);
    }
    if (bots.length > 10) console.log(`  ... and ${bots.length - 10} more`);
  }

  if (events) {
    console.log(
      `\nSynced events : ${events.counted}${events.hasMore ? "+ (more pages exist)" : ""}`
    );
  }

  return { connectionCount, botCount: bots ? bots.length : null };
}

function printDisconnectResult(data, usedDelete) {
  console.log(`\nDisconnected.${usedDelete ? "  (endpoint answered on DELETE)" : ""}`);
  if (data?.message) console.log(`  ${data.message}`);
  if (data?.disconnected != null) console.log(`  disconnected         : ${data.disconnected}`);
  if (data?.user_id) console.log(`  user_id              : ${data.user_id}`);
  if (data?.watch_channel_stopped != null) {
    console.log(`  watch_channel_stopped: ${data.watch_channel_stopped}`);
  }
  if (data?.events_deleted != null) console.log(`  events_deleted       : ${data.events_deleted}`);
  if (data?.schedules_cancelled != null) {
    console.log(`  schedules_cancelled  : ${data.schedules_cancelled}`);
  }
}

async function cmdDisconnect(flags) {
  const { connectionCount, botCount } = await preview();


  console.log("\n" + "=".repeat(64));
  console.log("DISCONNECTING REMOVES, IRREVERSIBLY:");
  console.log("  1. Push notification channels / Graph subscriptions (no more real-time sync)");
  console.log("  2. Every pending bot schedule" + (botCount ? ` (${botCount} right now)` : ""));
  console.log(
    "  3. All synced event data" + (flags.keepEvents ? "  <- SKIPPED, --keep-events was passed" : "")
  );
  console.log("  4. The stored OAuth credentials");
  console.log("");
  console.log("Bots that have already run keep their recordings and transcripts.");
  console.log("To reconnect afterwards you need your OAuth credentials again.");

  if (flags.provider || flags.accountId) {
    console.log("");
    console.log(`Scope: provider=${flags.provider ?? "(all)"}, account_id=${flags.accountId ?? "(all)"}`);
  } else if (connectionCount && connectionCount > 1) {
    console.log("");
    console.log(`Scope: ALL ${connectionCount} connections on this user.`);
  }
  console.log("=".repeat(64));

  if (!flags.yes && !(await confirm("\nThis cannot be undone."))) {
    console.log("Aborted. Nothing was changed.");
    return;
  }


  const body = buildDisconnectBody({
    provider: flags.provider,
    accountId: flags.accountId,
    keepEvents: flags.keepEvents,
  });

  console.log("\nPOST /calendar/disconnect");
  // Credentials may be in the body. Never print their values.
  const redacted = { ...body };
  for (const key of ["google_client_secret", "google_refresh_token", "google_client_id"]) {
    if (redacted[key]) redacted[key] = "<redacted>";
  }
  console.log(JSON.stringify(redacted, null, 2));

  const { status, data, usedDelete } = await disconnectCalendar(body);

  if (status === 400) {
    // The documented guard: several connections attached and no explicit
    // scope, so the API refuses to wipe everything by implication.
    console.log("\nRefused (HTTP 400).");
    const detail = data?.error || data?.message;
    if (detail) console.log(`  ${detail}`);
    if (data?.connection_count != null) console.log(`  connection_count: ${data.connection_count}`);
    if (data?.next_steps) console.log(`  next_steps: ${data.next_steps}`);
    console.log("\nRe-run naming the connection, for example:");
    console.log("  node index.js disconnect --provider outlook --account-id jane@acme.com");
    process.exitCode = 1;
    return;
  }

  printDisconnectResult(data, usedDelete);
  console.log("\nTo reconnect, use google-calendar-integration or outlook-calendar-integration.");
}

async function main() {
  requireApiKey();

  const { flags, positional } = parseFlags(process.argv.slice(2));
  const command = positional[0] ?? "preview";

  switch (command) {
    case "preview":
      await preview();
      console.log("\nNothing was changed. To actually disconnect:  node index.js disconnect");
      break;
    case "disconnect":
      await cmdDisconnect(flags);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node index.js [preview|disconnect] [--provider p] [--account-id a] [--keep-events] [--yes]");
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
