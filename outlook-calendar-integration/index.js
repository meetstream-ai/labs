/**
 * outlook-calendar-integration
 *
 * Connects an Outlook / Microsoft 365 calendar to MeetStream with OAuth
 * refresh-token credentials, then verifies the connection.
 *
 *   node index.js              connect the account
 *   node index.js --replace    reconnect an account that is already attached
 *
 * If you do not have a refresh token yet, run `npm run oauth` first.
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  connectOutlookCalendar,
  listConnections,
  listCalendars,
  formatCalendar,
} from "./src/calendar.js";

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`\nMissing required environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill it in.");
    if (missing.includes("MICROSOFT_REFRESH_TOKEN")) {
      console.error("\nTo obtain a refresh token, run:  npm run oauth");
    }
    process.exit(1);
  }
}

async function main() {
  requireEnv([
    "MEETSTREAM_API_KEY",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_REFRESH_TOKEN",
  ]);

  const replace = process.argv.includes("--replace");

  console.log("Connecting Outlook Calendar to MeetStream...");
  if (replace) console.log('Sending "replace": true (overwrites an existing connection for this account).');

  const { status, data } = await connectOutlookCalendar({
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    refreshToken: process.env.MICROSOFT_REFRESH_TOKEN,
    replace,
  });

  if (status === 409) {
    // The account is already attached to this MeetStream user. Not an error,
    // just a guard against silently clobbering a live connection.
    console.log("\nThis Microsoft account is already connected (HTTP 409).");
    const detail = data?.error || data?.message;
    if (detail) console.log(`  ${detail}`);
    console.log("\nTo rotate its credentials, re-run with:  node index.js --replace");
    return;
  }

  console.log("\nConnected.");
  if (data.account_id) console.log(`  Account id      : ${data.account_id}`);
  if (data.user_email) console.log(`  Email           : ${data.user_email}`);
  if (data.user_name) console.log(`  Name            : ${data.user_name}`);
  if (data.provider) console.log(`  Provider        : ${data.provider}`);
  if (data.platform) console.log(`  Platform        : ${data.platform}`);
  if (data.calendar_id) console.log(`  Connection id   : ${data.calendar_id}`);
  if (data.primary_calendar_id) console.log(`  Primary calendar: ${data.primary_calendar_id}`);

  const watch = data.watch_setup;
  if (watch) {
    // Graph change-notification subscriptions are what keep bot join times in
    // sync when a meeting moves. Surface partial failures.
    console.log(
      `  Subscriptions   : ${watch.subscriptions_setup ?? 0} registered` +
        (watch.success === false ? "  (setup reported a failure)" : "")
    );
    const failed = watch.failed_calendars;
    if (Array.isArray(failed) && failed.length) {
      console.log(`  Failed calendars: ${failed.length} (real-time sync is off for those)`);
    }
  }

  console.log("\nVerifying...");

  const connections = await listConnections();
  if (connections) {
    const outlook = Array.isArray(connections.outlook) ? connections.outlook : [];
    const google = Array.isArray(connections.google) ? connections.google : [];
    console.log(`\nConnections on this MeetStream user: ${connections.total ?? outlook.length + google.length}`);
    for (const conn of outlook) {
      console.log(
        `  - [outlook] ${conn.account_id}` +
          (conn.calendars_count != null ? `  (${conn.calendars_count} calendars)` : "")
      );
    }
    for (const conn of google) {
      console.log(`  - [google]  ${conn.account_id ?? conn.email ?? "(unnamed)"}`);
    }
  } else {
    console.log("(No calendars returned by GET /calendar, skipping.)");
  }

  const listed = await listCalendars();
  const calendars = Array.isArray(listed.calendars) ? listed.calendars : [];
  console.log(`\n${calendars.length} calendar(s) visible to MeetStream:`);
  for (const cal of calendars) console.log(formatCalendar(cal));

  console.log("\nNext steps:");
  console.log("  Sync events        -> calendar-event-sync template");
  console.log("  Schedule one bot   -> calendar-schedule-bot template");
  console.log("  Auto-join every    -> calendar-auto-schedule template");
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
