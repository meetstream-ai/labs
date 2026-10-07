#!/usr/bin/env node
/**
 * MeetStream Labs - Real-Time Transcription
 * index.js - thin entry point that loads .env and dispatches to the scripts.
 *
 *   node index.js server                     webhook receiver  (same as: node server.js)
 *   node index.js ws-server                  WebSocket receiver (same as: node ws-server.js)
 *   node index.js create-bot <meeting_url>   create a bot that POSTs live chunks to WEBHOOK_URL
 *   node index.js create-bot-ws <meeting_url> create a bot that streams to WEBSOCKET_URL
 */

try {
  require("dotenv").config();
} catch {
  // dotenv is optional: without it, set the variables in the shell instead.
}

const COMMANDS = {
  server: "./server.js",
  "ws-server": "./ws-server.js",
  "create-bot": "./create-bot.js",
  "create-bot-ws": "./create-bot-ws.js",
};

function printUsage() {
  console.log(
    [
      "Usage: node index.js <command> [meeting_url]",
      "",
      "  server                       start the webhook receiver on PORT (default 3000)",
      "  ws-server                    start the WebSocket receiver on PORT (default 3001)",
      "  create-bot <meeting_url>     send a bot; live chunks are POSTed to WEBHOOK_URL/webhook",
      "  create-bot-ws <meeting_url>  send a bot; live chunks stream to WEBSOCKET_URL/ws",
      "",
      "Env: MEETSTREAM_API_KEY (required for create-bot*), WEBHOOK_URL or WEBSOCKET_URL,",
      "     PROVIDER=deepgram|assemblyai, PORT. See .env.example.",
    ].join("\n")
  );
}

const command = process.argv[2];

if (!command || command === "--help" || command === "-h" || command === "help") {
  printUsage();
  process.exit(command ? 0 : 1);
}

if (!COMMANDS[command]) {
  console.error(`Unknown command "${command}".\n`);
  printUsage();
  process.exit(1);
}

// The scripts read the meeting URL from process.argv[2], so drop the command.
process.argv.splice(2, 1);
require(COMMANDS[command]);
