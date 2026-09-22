/**
 * google-calendar-integration
 *
 * Connects a Google Calendar to MeetStream with OAuth refresh-token
 * credentials, then verifies the connection by reading the calendar list back.
 *
 *   node index.js
 *
 * If you do not have a refresh token yet, run `npm run oauth` first.
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import { connectGoogleCalendar, listCalendars, formatCalendar } from "./src/calendar.js";

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`\nMissing required environment variables: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill it in.");
    if (missing.includes("GOOGLE_REFRESH_TOKEN")) {
      console.error("\nTo obtain a refresh token, run:  npm run oauth");
    }
    process.exit(1);
  }
}

async function main() {
  requireEnv([
    "MEETSTREAM_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ]);

  console.log("Connecting Google Calendar to MeetStream...");

  const connection = await connectGoogleCalendar({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  });

  console.log("\nConnected.");
  if (connection.user_email) console.log(`  Account         : ${connection.user_email}`);
  if (connection.user_name) console.log(`  Name            : ${connection.user_name}`);
  if (connection.calendar_id) console.log(`  Connection id   : ${connection.calendar_id}`);
  if (connection.platform) console.log(`  Platform        : ${connection.platform}`);
  if (connection.primary_calendar_id) {
    console.log(`  Primary calendar: ${connection.primary_calendar_id}`);
  }

  const watch = connection.watch_setup;
  if (watch) {
    // Watch channels are what make MeetStream react to calendar edits in real
    // time. A partial failure here is worth surfacing, not swallowing.
    console.log(
      `  Push channels   : ${watch.watches_setup ?? 0} set up` +
        (watch.success === false ? "  (setup reported a failure)" : "")
    );
    const failed = watch.failed_calendars;
    if (Array.isArray(failed) && failed.length) {
      console.log(`  Failed calendars: ${failed.length} (real-time sync is off for those)`);
    }
  }

  console.log("\nVerifying with GET /calendar ...");
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
