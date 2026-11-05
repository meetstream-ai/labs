/**
 * Every bot_status MeetStream reports, what it means, and which webhook
 * delivery carries it. These are the lifecycle values returned by
 * GET /bots/{id}/status and echoed in webhook payloads.
 *
 * Every ending arrives as ONE webhook with `event: "bot.stopped"`; the reason
 * is in the webhook's `bot_event` (bot.stopped | bot.kicked | bot.notallowed |
 * bot.denied | bot.failed). bot_status is coarser: a kick and a clean exit both
 * report "Stopped", and the failure value comes in varying case (FAILED, ERROR,
 * Failed). So compare bot_status case-insensitively, and use a webhook's
 * bot_event when you need the exact reason.
 */

export const STATUSES = [
  {
    status: "Joining",
    event: "bot.joining",
    terminal: false,
    meaning: "The bot has been dispatched and is dialling into the meeting.",
    note: "If it never leaves this state the meeting has probably not started.",
  },
  {
    status: "InWaitingRoom",
    event: "bot.in_waiting_room",
    terminal: false,
    meaning: "The bot is parked in the lobby waiting for a host to admit it.",
    note: "Controlled by automatic_leave.waiting_room_timeout. On timeout the bot ends as NotAllowed (bot_event bot.notallowed).",
  },
  {
    status: "InMeeting",
    event: "bot.inmeeting",
    terminal: false,
    meaning: "The bot was admitted and is now a participant.",
    note: "Being in the meeting is not the same as recording.",
  },
  {
    status: "Recording",
    event: "bot.recording",
    terminal: false,
    meaning: "Capture is running: audio, plus video when video_required is true.",
    note: "pause_recording and resume_recording toggle this without leaving the call.",
  },
  {
    status: "Leaving",
    event: "bot.leaving",
    terminal: false,
    meaning: "The bot is shutting the session down and exiting the meeting.",
    note: "Triggered by everyone leaving, a timeout, or GET /bots/{id}/remove_bot.",
  },
  {
    status: "Stopped",
    event: "bot.stopped (bot_event bot.stopped or bot.kicked)",
    terminal: true,
    meaning: "The bot is out of the meeting: a clean exit, or a participant removed it.",
    note: "A kick also reports Stopped. Only the webhook's bot_event (bot.kicked) tells them apart. status_code 200.",
  },
  {
    status: "NotAllowed",
    event: "bot.stopped (bot_event bot.notallowed)",
    terminal: true,
    meaning: "The bot timed out in the waiting room and was never admitted.",
    note: "The webhook arrives with status_code 500. No media exists; bot.done still follows.",
  },
  {
    status: "Denied",
    event: "bot.stopped (bot_event bot.denied)",
    terminal: true,
    meaning: "A host explicitly denied the bot entry or recording.",
    note: "status_code 500. On Zoom this interacts with recording_permission_denied_timeout (60 to 300s).",
  },
  {
    status: "Error",
    aliases: ["FAILED", "ERROR", "Failed"],
    event: "bot.stopped (bot_event bot.failed)",
    terminal: true,
    meaning: "The session failed. Recording may be partial or absent.",
    note: "Casing varies (FAILED, ERROR, Failed), so match it case-insensitively. Usually status_code 500. GET /bots/{id}/detail carries the reason.",
  },
  {
    status: "Done",
    event: "bot.done",
    terminal: true,
    meaning: "The session finished and all post-processing completed.",
    note: "bot.done is the final webhook on every path, streaming-only and never-admitted bots included.",
  },
];

export const TERMINAL_STATUSES = new Set(
  STATUSES.filter((s) => s.terminal).map((s) => s.status)
);

/** The happy path, in order. Used to draw the timeline scaffold. */
export const LIFECYCLE_ORDER = [
  "Joining",
  "InWaitingRoom",
  "InMeeting",
  "Recording",
  "Leaving",
  "Stopped",
];

/**
 * Post-session webhook events. These are NOT bot_status values: they arrive on
 * your callback_url after the bot has already stopped.
 */
export const POST_SESSION_EVENTS = [
  ["manifest.completed", "The session manifest is written."],
  ["audio.processed", "Audio is ready. Not final: bot.done still follows."],
  ["transcription.processed", "The post-call transcript is ready (post-call providers only)."],
  ["transcription.failed", "Transcription failed, status_code 500 (post-call providers only)."],
  ["video.processed", "Video is ready (only when video_required was true)."],
  ["bot.done", "Final event on every path, streaming-only included. bot_status becomes Done."],
  ["data_deletion", "The bot's media and transcripts were erased."],
];

/**
 * Map a raw bot_status to its canonical STATUSES entry name, case-insensitively,
 * so FAILED / ERROR / Failed all resolve to "Error". Unknown values pass through.
 */
export function canonical(status) {
  const needle = String(status ?? "").toLowerCase();
  const hit = STATUSES.find(
    (s) =>
      s.status.toLowerCase() === needle ||
      (s.aliases ?? []).some((a) => a.toLowerCase() === needle)
  );
  return hit ? hit.status : status;
}

export function describe(status) {
  return STATUSES.find((s) => s.status === canonical(status)) ?? null;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(canonical(status));
}

/** Prints the full reference table. Used by `node index.js --explain`. */
export function printReference() {
  console.log("\nBOT STATUS REFERENCE");
  console.log("=".repeat(72));
  for (const s of STATUSES) {
    const tag = s.terminal ? "[terminal]" : "[in flight]";
    console.log(`\n${s.status}  ${tag}`);
    console.log(`  webhook : ${s.event}`);
    console.log(`  means   : ${s.meaning}`);
    console.log(`  note    : ${s.note}`);
  }

  console.log("\n\nPOST-SESSION WEBHOOK EVENTS");
  console.log("=".repeat(72));
  for (const [event, meaning] of POST_SESSION_EVENTS) {
    console.log(`  ${event.padEnd(26)} ${meaning}`);
  }

  console.log("\n\nGOTCHAS");
  console.log("=".repeat(72));
  console.log("  1. Every webhook carries `event`. Most also carry `bot_event`, which");
  console.log("     differs only on terminals: every ending is event bot.stopped, and");
  console.log("     bot_event holds the reason (bot.stopped, bot.kicked, bot.notallowed,");
  console.log("     bot.denied, bot.failed). Branch on bot_event, not bot_status.");
  console.log("  2. bot.stopped is status_code 200 for a clean exit or a kick, and 500");
  console.log("     for NotAllowed, Denied and most failures.");
  console.log("  3. bot.error is NOT terminal. It reports a streaming provider fault");
  console.log("     while the bot keeps running.");
  console.log("  4. transcript_id never appears in a webhook. Read it from the");
  console.log("     create_bot response, GET /bots/{id}/detail, or /transcriptions.");
  console.log("  5. bot.done is the final webhook on every path. audio.processed is");
  console.log("     never final, even for streaming-only providers.");
  console.log("");
}
