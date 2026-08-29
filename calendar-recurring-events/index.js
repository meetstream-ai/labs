/**
 * calendar-recurring-events
 *
 * Handles recurring meetings: the whole series versus a single occurrence,
 * and auto-rescheduling with POST /calendar/toggle-recurrence.
 *
 *   node index.js list                              show events and their recurrence
 *   node index.js on  <eventId>                     enable auto-rescheduling
 *   node index.js off <eventId>                     disable auto-rescheduling
 *   node index.js schedule-chain  <eventId>         bot on this one, next auto-booked after
 *   node index.js schedule-series <eventId> [n]     bot on every future occurrence now
 *   node index.js schedule-one <eventId> <iso>      bot on one specific occurrence
 *   node index.js cancel-series <eventId>           cancel the whole series
 *   node index.js cancel-from <eventId> <iso>       cancel occurrences from a date on
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  fetchEvents,
  toggleRecurrence,
  scheduleRecurring,
  cancelSchedule,
  buildBotConfig,
  inspectRecurrence,
  eventTitle,
} from "./src/recurring.js";

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

function requireId(eventId, usage) {
  if (!eventId) {
    console.error(`\nThis command needs an event id.\nUsage: ${usage}`);
    console.error("Find ids with:  node index.js list");
    process.exit(1);
  }
}

async function cmdList() {
  const events = await fetchEvents({ limit: 100 });
  const live = events.filter((e) => !e.is_deleted);

  if (!live.length) {
    console.log("No events in the sync window. Connect a calendar first.");
    return;
  }

  live.sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

  console.log(`${live.length} event(s):\n`);
  let recurringCount = 0;

  for (const event of live) {
    const recurrence = inspectRecurrence(event);
    if (recurrence) recurringCount += 1;

    const marker = recurrence
      ? recurrence.kind === "series"
        ? `[series: ${recurrence.rule}]`
        : "[occurrence of a series]"
      : "[single]";

    const bots = Array.isArray(event.bots) ? event.bots : [];
    console.log(`  ${event.id}`);
    console.log(`    ${eventTitle(event)}  ${marker}`);
    console.log(
      `    starts ${event.start_time}` +
        (event.meeting_url ? `  link: yes` : `  link: no`) +
        (bots.length ? `  bots: ${bots.length}` : "")
    );
  }

  console.log(`\n${recurringCount} of ${live.length} look recurring.`);
  console.log("That reading comes from the raw provider payload and is a hint only.");
  console.log("toggle-recurrence is the authority: it returns 400 for an event with no rule.");
}

async function cmdToggle(eventId, enabled) {
  requireId(eventId, `node index.js ${enabled ? "on" : "off"} <eventId>`);

  console.log(`${enabled ? "Enabling" : "Disabling"} auto-rescheduling for ${eventId}...`);

  const { status, data } = await toggleRecurrence(eventId, enabled);

  if (status === 400) {
    // The documented meaning of a 400 here: the event carries no RRULE.
    console.log("\nThis event is not recurring (HTTP 400).");
    const detail = data?.message || data?.error || data?.detail;
    if (detail) console.log(`  ${detail}`);
    console.log("\ntoggle-recurrence only applies to events with a recurrence rule.");
    console.log("For a one-off meeting use the calendar-schedule-bot template instead.");
    return;
  }

  console.log("\nDone.");
  if (data.recurring_enabled != null) console.log(`  recurring_enabled: ${data.recurring_enabled}`);
  if (data.recurrence_rule) console.log(`  recurrence_rule  : ${data.recurrence_rule}`);
  if (data.summary) console.log(`  summary          : ${data.summary}`);
  if (data.start_time) console.log(`  start_time       : ${data.start_time}`);
  if (data.end_time) console.log(`  end_time         : ${data.end_time}`);
  if (data.message) console.log(`  ${data.message}`);

  if (enabled) {
    console.log("\nAfter each occurrence ends, MeetStream computes the next one from the");
    console.log("recurrence rule and schedules a bot for it with the same config.");
  }
}

function printScheduleResult(status, data, eventId) {
  if (status === 409) {
    console.log("\nAlready scheduled (HTTP 409). MeetStream will not double-book an event.");
    const existingBotId = data?.bot_id ?? data?.existing_bot_id;
    if (existingBotId) console.log(`  Existing bot id: ${existingBotId}`);
    console.log("\nEdit it with the manage-scheduled-bots template, or cancel first:");
    console.log(`  node index.js cancel-series ${eventId}`);
    return;
  }

  console.log("\nScheduled.");
  if (data.bot_id) console.log(`  Bot id              : ${data.bot_id}`);
  if (data.schedule_id) console.log(`  Schedule id         : ${data.schedule_id}`);
  if (data.schedule_group) console.log(`  Schedule group      : ${data.schedule_group}`);
  if (data.scheduled_time) console.log(`  Joins at            : ${data.scheduled_time}`);
  if (data.occurrence_date) console.log(`  Occurrence date     : ${data.occurrence_date}`);
  if (data.is_recurring_occurrence != null) {
    console.log(`  Recurring occurrence: ${data.is_recurring_occurrence}`);
  }
  if (data.existing_schedules != null) {
    console.log(`  Existing schedules  : ${data.existing_schedules}`);
  }
}

async function cmdScheduleChain(eventId) {
  requireId(eventId, "node index.js schedule-chain <eventId>");

  console.log(`Scheduling ${eventId} with recurring_event: true`);
  console.log("(one bot now, and the next occurrence is booked automatically after each meeting)");

  const { status, data } = await scheduleRecurring(eventId, buildBotConfig(), {
    recurringEvent: true,
  });
  printScheduleResult(status, data, eventId);
}

async function cmdScheduleSeries(eventId, limitArg) {
  requireId(eventId, "node index.js schedule-series <eventId> [occurrenceLimit]");

  const occurrenceLimit = Number(limitArg || process.env.OCCURRENCE_LIMIT || 52);

  console.log(`Scheduling ${eventId} with schedule_all_occurrences: true`);
  console.log(`occurrence_limit: ${occurrenceLimit} (API default is 52)`);

  const { status, data } = await scheduleRecurring(eventId, buildBotConfig(), {
    scheduleAllOccurrences: true,
    occurrenceLimit,
  });
  printScheduleResult(status, data, eventId);

  if (status !== 409) {
    console.log("\nEvery future occurrence now has its own bot and its own schedule.");
    console.log("List them with the manage-scheduled-bots template.");
  }
}

async function cmdScheduleOne(eventId, occurrenceDate) {
  requireId(eventId, "node index.js schedule-one <eventId> <occurrenceDateIso>");
  if (!occurrenceDate) {
    console.error("\nThis command needs an occurrence date, ISO 8601.");
    console.error("Usage: node index.js schedule-one evt_abc123 2026-04-14T10:00:00Z");
    process.exit(1);
  }

  console.log(`Scheduling one occurrence of ${eventId} on ${occurrenceDate}`);

  const { status, data } = await scheduleRecurring(eventId, buildBotConfig(), {
    occurrenceDate,
  });
  printScheduleResult(status, data, eventId);
}

async function cmdCancelSeries(eventId) {
  requireId(eventId, "node index.js cancel-series <eventId>");

  console.log(`Cancelling every scheduled occurrence of ${eventId}...`);
  const data = await cancelSchedule(eventId, { cancelAllOccurrences: true });

  console.log("\nCancelled.");
  if (data.schedules_cancelled != null) console.log(`  Schedules cancelled: ${data.schedules_cancelled}`);
  if (data.bots_deleted != null) console.log(`  Bots deleted       : ${data.bots_deleted}`);
  if (data.is_recurring_series != null) console.log(`  Recurring series   : ${data.is_recurring_series}`);
}

async function cmdCancelFrom(eventId, fromDate) {
  requireId(eventId, "node index.js cancel-from <eventId> <fromDateIso>");
  if (!fromDate) {
    console.error("\nThis command needs a from date, ISO 8601.");
    console.error("Usage: node index.js cancel-from evt_abc123 2026-05-01T00:00:00Z");
    process.exit(1);
  }

  console.log(`Cancelling occurrences of ${eventId} from ${fromDate} onwards...`);
  const data = await cancelSchedule(eventId, { cancelAllOccurrences: true, fromDate });

  console.log("\nCancelled.");
  if (data.schedules_cancelled != null) console.log(`  Schedules cancelled: ${data.schedules_cancelled}`);
  if (data.bots_deleted != null) console.log(`  Bots deleted       : ${data.bots_deleted}`);
  console.log("  Occurrences before that date keep their bots.");
}

async function main() {
  requireApiKey();
  const [command, arg1, arg2] = process.argv.slice(2);

  switch (command ?? "list") {
    case "list":
      await cmdList();
      break;
    case "on":
      await cmdToggle(arg1, true);
      break;
    case "off":
      await cmdToggle(arg1, false);
      break;
    case "schedule-chain":
      await cmdScheduleChain(arg1);
      break;
    case "schedule-series":
      await cmdScheduleSeries(arg1, arg2);
      break;
    case "schedule-one":
      await cmdScheduleOne(arg1, arg2);
      break;
    case "cancel-series":
      await cmdCancelSeries(arg1);
      break;
    case "cancel-from":
      await cmdCancelFrom(arg1, arg2);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Usage: node index.js [list|on|off|schedule-chain|schedule-series|schedule-one|cancel-series|cancel-from] ..."
      );
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
