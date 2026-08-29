/**
 * calendar-auto-schedule
 *
 * Hands-free mode: a bot joins every meeting on the connected calendar that
 * has a meeting link, with no per-event API calls.
 *
 *   node index.js status     show whether auto-join is on, and the current config
 *   node index.js enable     turn it on with default_bot_config
 *   node index.js disable    turn it off
 *
 * The API reference pages titled "Setup Cron" and "Disable Cron" document
 * these same two endpoints. See the README.
 */

import "dotenv/config";
import { reportError } from "./src/api.js";
import {
  buildDefaultBotConfig,
  enableAutoSchedule,
  disableAutoSchedule,
  getAutoScheduleSettings,
  listScheduledBots,
} from "./src/autoschedule.js";

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("\nMEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }
}

function printSettings(settings) {
  const enabled = settings?.auto_schedule_enabled;
  console.log(`Auto-scheduling: ${enabled ? "ENABLED" : "disabled"}`);
  if (settings?.default_bot_config) {
    console.log("\ndefault_bot_config:");
    console.log(JSON.stringify(settings.default_bot_config, null, 2));
  }
}

async function cmdStatus() {
  const settings = await getAutoScheduleSettings();
  printSettings(settings);

  const bots = await listScheduledBots();
  console.log(`\n${bots.length} bot(s) currently scheduled to join a future meeting:`);
  for (const bot of bots.slice(0, 20)) {
    console.log(
      `  - ${bot.scheduled_join_time ?? "(no time)"}  ${bot.platform ?? "?"}  ` +
        `${bot.status ?? "?"}  ${bot.bot_id ?? "(no id)"}`
    );
  }
  if (bots.length > 20) console.log(`  ... and ${bots.length - 20} more`);

  if (settings?.auto_schedule_enabled && bots.length === 0) {
    console.log("\nNone yet. The background job runs once every 24 hours at midnight UTC");
    console.log("and only looks at the next 24 hours of meetings, so a calendar you just");
    console.log("connected will not have bots until the next run. Schedule anything urgent");
    console.log("manually with the calendar-schedule-bot template.");
  }
}

async function cmdEnable() {
  const defaultBotConfig = buildDefaultBotConfig();

  console.log("Enabling auto-scheduling with default_bot_config:");
  console.log(JSON.stringify(defaultBotConfig, null, 2));

  const data = await enableAutoSchedule(defaultBotConfig);

  console.log("\nEnabled.");
  if (data.message) console.log(`  ${data.message}`);
  if (data.auto_schedule_enabled != null) {
    console.log(`  auto_schedule_enabled: ${data.auto_schedule_enabled}`);
  }

  console.log("\nWhat happens now:");
  console.log("  - A background job runs every 24 hours at midnight UTC.");
  console.log("  - It scans the next 24 hours of events for a valid meeting link.");
  console.log("  - Events that already have a bot are skipped, so this composes safely");
  console.log("    with anything you scheduled by hand.");
  console.log("  - Each bot joins 1 minute before its meeting starts.");
  console.log("  - Events with no meeting link are skipped entirely.");
  console.log("\nCheck on it with:  node index.js status");
}

async function cmdDisable() {
  console.log("Disabling auto-scheduling...");
  const data = await disableAutoSchedule();

  console.log("\nDisabled.");
  if (data.message) console.log(`  ${data.message}`);
  if (data.auto_schedule_enabled != null) {
    console.log(`  auto_schedule_enabled: ${data.auto_schedule_enabled}`);
  }

  const bots = await listScheduledBots();
  if (bots.length) {
    // Disabling stops future runs. Bots already on the books stay booked.
    console.log(`\nNote: ${bots.length} bot(s) are still scheduled from earlier runs.`);
    console.log("Disabling stops new bots being created, it does not cancel existing ones.");
    console.log("Cancel them with the manage-scheduled-bots template.");
  }
}

async function main() {
  requireApiKey();

  const command = process.argv[2] ?? "status";

  switch (command) {
    case "status":
      await cmdStatus();
      break;
    case "enable":
      await cmdEnable();
      break;
    case "disable":
      await cmdDisable();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node index.js [status|enable|disable]");
      process.exit(1);
  }
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
