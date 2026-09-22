/**
 * delete-bot-data
 *
 * DESTRUCTIVE. This template permanently erases a bot's recordings and
 * transcripts with DELETE /bots/{id}/delete, behind an explicit confirmation
 * prompt, and shows the `data_deletion` webhook that fires as a result.
 *
 *   node index.js listen              start the webhook listener
 *   node index.js delete <bot_id>     erase that bot's data (asks first)
 *   node index.js inspect <bot_id>    show what would be erased, delete nothing
 */

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { call, request, reportError, errorMessage } from "./src/api.js";

// src/webhook.js pulls in express, which only the `listen` command needs, so it
// is imported lazily. Deleting data should not require a web framework.

function requireApiKey() {
  if (!process.env.MEETSTREAM_API_KEY) {
    console.error("MEETSTREAM_API_KEY is not set.");
    console.error("Copy .env.example to .env and add your key from https://app.meetstream.ai");
    process.exit(1);
  }
}

function printUsage() {
  console.log(`
delete-bot-data  (destructive: read the README first)

  node index.js listen                 start the webhook listener on PORT
  node index.js inspect <bot_id>       show what exists for a bot, delete nothing
  node index.js delete  <bot_id>       permanently erase that bot's data
  node index.js delete  <bot_id> --force   skip the prompt (for scripts)

The delete is irreversible. There is no undo, no trash, no restore.
`);
}

/**
 * Reads GET /bots/{id}/detail so the operator can see what is about to be
 * destroyed. Never blocks the flow: if detail is unavailable the prompt still
 * runs, it just has less to show.
 */
async function inspect(botId) {
  const { status, data } = await request(`/bots/${botId}/detail`);

  if (status === 404) {
    console.log(`No bot found with id ${botId}.`);
    console.log("It may already have been deleted, or the id is wrong.");
    return null;
  }

  if (status < 200 || status >= 300) {
    console.log(`Could not read detail (HTTP ${status}): ${errorMessage(data, status)}`);
    return null;
  }

  console.log(`Bot ${botId}`);
  const fields = [
    "bot_name",
    "bot_status",
    "status",
    "platform",
    "meeting_url",
    "meeting_link",
    "transcript_id",
    "caption_file",
    "duration",
    "created_at",
  ];
  let printed = 0;
  for (const key of fields) {
    const value = data?.[key];
    if (value === undefined || value === null || value === "" || typeof value === "object") continue;
    console.log(`  ${key.padEnd(16)} ${value}`);
    printed += 1;
  }
  if (printed === 0) console.log("  (detail returned no scalar fields to show)");

  console.log("\nDeleting this bot erases:");
  console.log("  - the audio recording");
  console.log("  - the video recording and any per-participant streams");
  console.log("  - screenshots");
  console.log("  - the transcript" + (data?.transcript_id ? ` (${data.transcript_id})` : ""));
  console.log("");

  return data;
}

/**
 * Typing the full bot id is deliberately more friction than typing "y".
 * Deletion cannot be undone, so a slip of the finger should not be enough.
 */
async function confirmDeletion(botId) {
  if (!stdin.isTTY) {
    console.error("Not an interactive terminal, so the confirmation prompt cannot run.");
    console.error("Re-run with --force if you are certain, or run it interactively.");
    return false;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("This is permanent. There is no undo.");
    const answer = await rl.question(`Type the bot id to confirm deletion (${botId}): `);
    return answer.trim() === botId;
  } finally {
    rl.close();
  }
}

async function deleteBotData(botId, { force }) {
  console.log("=".repeat(68));
  console.log("PERMANENT DELETION");
  console.log("=".repeat(68) + "\n");

  await inspect(botId);

  if (!force) {
    const confirmed = await confirmDeletion(botId);
    if (!confirmed) {
      console.log("\nNot confirmed. Nothing was deleted.");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("--force given, skipping the confirmation prompt.\n");
  }

  console.log(`\nDELETE /bots/${botId}/delete ...`);
  const { status, data } = await call(`/bots/${botId}/delete`, { method: "DELETE" });

  console.log(`HTTP ${status}`);
  if (data) console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));

  console.log("\nDeleted. A `data_deletion` webhook fires to the bot's callback_url.");
  console.log("Run `node index.js listen` in another terminal to watch it arrive,");
  console.log("as long as that bot was created with a callback_url pointing there.");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  const botId = rest.find((a) => !a.startsWith("--")) ?? process.env.BOT_ID ?? null;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "listen") {
    const { startWebhookServer } = await import("./src/webhook.js");
    startWebhookServer(Number(process.env.PORT || 3000));
    return; // the server keeps the process alive
  }

  requireApiKey();

  if (!botId) {
    console.error(`\`${command}\` needs a bot id. Pass it as an argument or set BOT_ID.`);
    printUsage();
    process.exit(1);
  }

  if (command === "inspect") {
    await inspect(botId);
    console.log("Nothing was deleted. Use `delete` for that.");
    return;
  }

  if (command === "delete") {
    await deleteBotData(botId, { force });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
