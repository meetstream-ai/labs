#!/usr/bin/env node
/**
 * MeetStream Labs: Send Image Bot
 * ================================
 * Two ways to get a picture into a meeting, and they are genuinely different:
 *
 *   chat mode         POST /bots/{bot_id}/send_image
 *                     { "img_url": "<PUBLIC url>", "display_duration": 5 }
 *                     Puts the image (or animated GIF) in the meeting CHAT.
 *                     img_url is fetched by MeetStream's servers, so it must be
 *                     publicly reachable. There is NO base64 form of this call.
 *
 *   video-frame mode  sendimg_url / sendimg over the control WebSocket
 *                     Replaces the bot's outgoing CAMERA FEED with the image.
 *                     Requires the bot to be created with socket_connection_url.
 *
 *   node index.js --bot-id <id> --img-url https://example.com/chart.png
 *   node index.js --mode video-frame --meeting-link <url> --img-url https://example.com/avatar.gif
 */

import "dotenv/config";
import { log, c } from "./src/logger.js";
import { MeetStreamClient, MeetStreamError } from "./src/meetstream.js";
import { parseArgs, validate, assertPublicImageUrl, USAGE } from "./src/cli.js";
import { runVideoFrameMode } from "./src/video-frame.js";

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(USAGE);
    return;
  }

  validate(opts);

  // Every URL is checked before anything is created, so a typo or a localhost
  // link fails here rather than as an opaque 400 with a bot already in a meeting.
  for (const raw of opts.imgUrls) {
    const { warnHttp } = assertPublicImageUrl(raw);
    if (warnHttp) {
      log.warn(`${raw} is plain http. It will usually work, but https is strongly preferred.`);
    }
  }

  log.banner(
    "MeetStream Labs: Send Image Bot",
    opts.mode === "chat"
      ? "POST /bots/{id}/send_image: image into the meeting chat"
      : "sendimg_url over the control socket: image as the bot's camera feed"
  );

  if (opts.dryRun) {
    log.info(`Mode: ${opts.mode}`);
    for (const url of opts.imgUrls) log.detail(`img_url = ${url}`);
    if (opts.imgFile) log.detail(`img file (base64) = ${opts.imgFile}`);
    if (opts.displayDuration !== undefined) log.detail(`display_duration = ${opts.displayDuration}`);
    log.warn("--dry-run: no API calls made.");
    return;
  }

  if (!process.env.MEETSTREAM_API_KEY) {
    throw new Error("Missing MEETSTREAM_API_KEY. Copy .env.example to .env and fill it in.");
  }

  const client = new MeetStreamClient(process.env.MEETSTREAM_API_KEY, { logger: log });

  if (opts.mode === "chat") {
    const imgUrl = opts.imgUrls[0];
    log.info(`Posting ${c("cyan", imgUrl)} into the chat of bot ${opts.botId} …`);

    const result = await client.sendImage(opts.botId, {
      imgUrl,
      displayDuration: opts.displayDuration,
      metadata: { message_type: "image" },
    });

    const replay = result._replayed ? " (idempotent replay: already delivered)" : "";
    log.success(`send_image accepted${replay}`);
    log.detail(JSON.stringify(result, null, 2));
    return;
  }

  await runVideoFrameMode(client, {
    meetingLink: opts.meetingLink,
    botName: opts.botName,
    imgUrls: opts.imgUrls,
    imgFile: opts.imgFile,
    interval: opts.interval,
    duration: opts.duration,
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
  });
}

main().catch((err) => {
  if (err instanceof MeetStreamError) {
    log.error(`MeetStream API ${err.status} on ${err.path}: ${err.message}`);
    if (err.hint) log.detail(err.hint);
    if (err.status === 400) {
      log.detail("The body must be { img_url, display_duration? }: the field is img_url, not image_url.");
    }
  } else {
    log.error(err.message);
    if (/Unknown option|requires a value|needs |--mode|cannot be used/i.test(err.message)) {
      console.log(USAGE);
    }
  }
  process.exit(1);
});
