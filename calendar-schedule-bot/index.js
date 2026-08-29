/**
 * calendar-schedule-bot
 *
 * Schedules a MeetStream bot for one calendar event, handles the duplicate
 * (409) case gracefully, and unschedules again.
 *
 *   node index.js schedule [eventId]     schedule a bot
 *   node index.js unschedule [eventId]   remove the scheduled bot
 *   node index.js status [eventId]       show what is currently scheduled
 *
 * With no eventId the template picks the soonest upcoming event that has a
 * meeting link and no bot yet, or uses EVENT_ID from .env.
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  buildBotConfig,
  scheduleBot,
  unscheduleBot,
  fetchEvents,
  pickSchedulableEvent,
} from "./src/schedule.js";

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

function eventTitle(event) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  return raw.summary || raw.subject || "(untitled)";
}

/** Resolves the event to act on: CLI argument, then EVENT_ID, then auto-pick. */
async function resolveEvent(explicitId) {
  const wanted = explicitId || process.env.EVENT_ID;
  const events = await fetchEvents({ limit: 100 });

  if (wanted) {
    const match = events.find((e) => e.id === wanted);
    // The event may sit outside the default sync window. Act on the id anyway
    // rather than refusing, and say that we could not enrich it.
    return { id: wanted, event: match ?? null, events };
  }

  const picked = pickSchedulableEvent(events);
  if (!picked) {
    console.error("\nNo upcoming event found with a meeting link and no bot already scheduled.");
    console.error("Run the calendar-event-sync template to see what is on the calendar,");
    console.error("then pass an event id:  node index.js schedule evt_xxx");
    process.exit(1);
  }
  return { id: picked.id, event: picked, events };
}

function describeEvent(event) {
  if (!event) return;
  console.log(`  Title      : ${eventTitle(event)}`);
  console.log(`  Starts     : ${event.start_time}`);
  if (event.meeting_platform) console.log(`  Platform   : ${event.meeting_platform}`);
  if (event.meeting_url) console.log(`  Meeting url: ${event.meeting_url}`);
}

async function cmdSchedule(explicitId) {
  const { id, event } = await resolveEvent(explicitId);

  console.log(`Scheduling a bot for event ${id}`);
  describeEvent(event);
  if (!event) console.log("  (event not in the current sync window, scheduling by id anyway)");

  const botConfig = buildBotConfig();
  console.log("\nbot_config:");
  console.log(JSON.stringify(botConfig, null, 2));

  const { status, data } = await scheduleBot(id, botConfig, {
    recurringEvent: String(process.env.RECURRING_EVENT || "false").toLowerCase() === "true",
  });

  if (status === 409) {
    // Deduplication, not a failure. MeetStream refuses to double-book an event
    // and hands back the bot that is already there.
    console.log("\nAlready scheduled (HTTP 409). MeetStream will not double-book an event.");
    const existingBotId = data?.bot_id ?? data?.existing_bot_id;
    if (existingBotId) console.log(`  Existing bot id: ${existingBotId}`);
    const detail = data?.message || data?.error;
    if (detail) console.log(`  ${detail}`);
    console.log("\nTo change that bot's join time or name, use the manage-scheduled-bots");
    console.log("template (PATCH /calendar/scheduled_bots/{bot_id}).");
    console.log(`To remove it:  node index.js unschedule ${id}`);
    return;
  }

  console.log("\nScheduled.");
  if (data.bot_id) console.log(`  Bot id          : ${data.bot_id}`);
  if (data.schedule_id) console.log(`  Schedule id     : ${data.schedule_id}`);
  if (data.scheduled_time) console.log(`  Joins at        : ${data.scheduled_time}`);
  if (data.schedule_group) console.log(`  Schedule group  : ${data.schedule_group}`);
  if (data.is_recurring_occurrence != null) {
    console.log(`  Recurring       : ${data.is_recurring_occurrence}`);
  }
  if (data.existing_schedules != null) {
    console.log(`  Existing sched. : ${data.existing_schedules}`);
  }

  console.log("\nThe bot joins 1 minute before the meeting starts.");
  console.log(`To cancel:  node index.js unschedule ${id}`);
}

async function cmdUnschedule(explicitId) {
  const wanted = explicitId || process.env.EVENT_ID;
  if (!wanted) {
    console.error("\nUnschedule needs an event id:  node index.js unschedule evt_xxx");
    console.error("Or set EVENT_ID in .env.");
    process.exit(1);
  }

  console.log(`Unscheduling bot for event ${wanted}...`);

  const data = await unscheduleBot(wanted, {
    cancelAllOccurrences:
      String(process.env.CANCEL_ALL_OCCURRENCES || "false").toLowerCase() === "true",
    fromDate: process.env.CANCEL_FROM_DATE,
  });

  console.log("\nUnscheduled.");
  if (data.schedules_cancelled != null) console.log(`  Schedules cancelled: ${data.schedules_cancelled}`);
  if (data.bots_deleted != null) console.log(`  Bots deleted       : ${data.bots_deleted}`);
  if (data.is_recurring_series != null) console.log(`  Recurring series   : ${data.is_recurring_series}`);
  if (Array.isArray(data.cancelled_schedules) && data.cancelled_schedules.length) {
    console.log(`  Cancelled ids      : ${data.cancelled_schedules.join(", ")}`);
  }
}

async function cmdStatus(explicitId) {
  const { id, event } = await resolveEvent(explicitId);
  console.log(`Event ${id}`);
  describeEvent(event);

  const bots = event && Array.isArray(event.bots) ? event.bots : [];
  if (!bots.length) {
    console.log("\nNo bot scheduled for this event.");
    return;
  }

  console.log(`\n${bots.length} bot(s) attached:`);
  for (const bot of bots) {
    console.log(
      `  - ${bot.id ?? bot.bot_id ?? "(no id)"}  status=${bot.status ?? "?"}` +
        (bot.scheduled_join_time ? `  joins=${bot.scheduled_join_time}` : "")
    );
  }
}

async function main() {
  requireApiKey();

  const [command, eventId] = process.argv.slice(2);

  switch (command) {
    case undefined:
    case "schedule":
      await cmdSchedule(eventId);
      break;
    case "unschedule":
      await cmdUnschedule(eventId);
      break;
    case "status":
      await cmdStatus(eventId);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node index.js [schedule|unschedule|status] [eventId]");
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
