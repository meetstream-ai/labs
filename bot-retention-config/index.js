/**
 * bot-retention-config
 *
 * Creates bots with an explicit `recording_config.retention` window, or with no
 * retention block so the bot inherits the API default, and explains exactly
 * what the window controls.
 *
 *   node index.js --explain                  retention semantics, no API call
 *   node index.js --mode timed --hours 72    create a bot kept for 72 hours
 *   node index.js --mode default             create a bot on the default window
 *   node index.js --mode timed --hours 2 --dry-run   print the body, send nothing
 */

import "dotenv/config";
import { call, request, reportError, errorMessage } from "./src/api.js";
import {
  buildRecordingConfig,
  describeMode,
  printExplainer,
  DEFAULT_RETENTION_HOURS,
} from "./src/retention.js";

function parseArgs(argv) {
  const args = {
    mode: process.env.RETENTION_MODE || "timed",
    hours: Number(process.env.RETENTION_HOURS || 72),
    transcript: false,
    dryRun: false,
    explain: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--hours":
        args.hours = Number(argv[++i]);
        break;
      case "--transcript":
        args.transcript = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--explain":
        args.explain = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  if (!["timed", "default"].includes(args.mode)) {
    console.error(`--mode must be "timed" or "default", got "${args.mode}"`);
    process.exit(1);
  }

  return args;
}

function printUsage() {
  console.log(`
Usage: node index.js [options]

  --explain            print retention semantics and exit (no API key needed)
  --mode timed         send recording_config.retention = { type, hours }
  --mode default       send no retention block, inherit the API default
                       (${DEFAULT_RETENTION_HOURS} hours)
  --hours <n>          hours to keep artifacts, with --mode timed
  --transcript         also attach a deepgram post-call transcript provider,
                       so you can see retention apply to the transcript too
  --dry-run            print the request body and exit without creating a bot
`);
}

function requireConfig(dryRun) {
  const problems = [];
  if (!dryRun && !process.env.MEETSTREAM_API_KEY) problems.push("MEETSTREAM_API_KEY");
  if (!process.env.MEETING_LINK) problems.push("MEETING_LINK");

  if (problems.length > 0) {
    console.error(`Missing required config: ${problems.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values.");
    process.exit(1);
  }
}

/**
 * detail echoes the original request payload, which is the honest way to check
 * that the retention block was accepted as sent. The payload is nested and the
 * exact key path varies, so search for the retention object rather than
 * hardcoding a path that may not exist.
 */
function findRetention(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (node.retention && typeof node.retention === "object") return node.retention;
  for (const value of Object.values(node)) {
    const found = findRetention(value, depth + 1);
    if (found) return found;
  }
  return null;
}

async function verify(botId) {
  const { status, data } = await request(`/bots/${botId}/detail`);
  if (status < 200 || status >= 300) {
    console.log(`\nCould not read detail (HTTP ${status}): ${errorMessage(data, status)}`);
    return;
  }

  const retention = findRetention(data);
  console.log("\nRead back from GET /bots/{id}/detail:");
  if (retention) {
    console.log(`  retention: ${JSON.stringify(retention)}`);
  } else {
    console.log("  no retention block in the stored payload, so this bot is on");
    console.log(`  the default window (${DEFAULT_RETENTION_HOURS} hours).`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.explain) {
    printExplainer();
    return;
  }

  requireConfig(args.dryRun);

  const recordingConfig = buildRecordingConfig(args);

  const body = {
    meeting_link: process.env.MEETING_LINK,
    bot_name: process.env.BOT_NAME || "Retention Demo Bot",
    video_required: String(process.env.VIDEO_REQUIRED || "false") === "true",
    ...(recordingConfig ? { recording_config: recordingConfig } : {}),
  };

  for (const line of describeMode(args.mode, args.hours)) console.log(line);
  console.log("\nPOST /bots/create_bot");
  console.log(JSON.stringify(body, null, 2));

  if (args.dryRun) {
    console.log("\n--dry-run, nothing was sent.");
    return;
  }

  const { status, data } = await call("/bots/create_bot", { method: "POST", body });

  console.log(`\nCreated (HTTP ${status})`);
  console.log(`  bot_id        : ${data?.bot_id}`);
  console.log(`  transcript_id : ${data?.transcript_id ?? "(none, no transcription provider set)"}`);

  if (args.mode === "timed") {
    const expires = new Date(Date.now() + args.hours * 3600 * 1000);
    console.log(`\nArtifacts expire roughly ${args.hours}h after the session ends.`);
    console.log(`If the call ended right now that would be around ${expires.toISOString()}.`);
  } else {
    console.log(`\nArtifacts expire on the default window (${DEFAULT_RETENTION_HOURS} hours).`);
  }

  if (data?.bot_id) await verify(data.bot_id);

  console.log("\nFetch and store anything you need to keep before the window closes.");
  console.log("Run `node index.js --explain` for the full semantics.");
}

main().catch((err) => {
  reportError(err);
  process.exit(1);
});
