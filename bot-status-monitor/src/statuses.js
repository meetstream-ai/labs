/**
 * Every bot_status MeetStream reports, what it means, and which webhook event
 * carries it. Nothing here is guesswork: these are the documented lifecycle
 * values returned by GET /bots/{id}/status and echoed in webhook payloads.
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
    note: "Controlled by automatic_leave.waiting_room_timeout. On timeout the bot ends as NotAllowed.",
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
    event: "bot.stopped",
    terminal: true,
    meaning: "The session ended normally. The bot is out of the meeting.",
    note: "bot.stopped always arrives with status_code 200, whatever the reason.",
  },
  {
    status: "NotAllowed",
    event: "bot.stopped",
    terminal: true,
    meaning: "The bot timed out in the waiting room and was never admitted.",
    note: "Still a 200 webhook. Check bot_status, not the status code, to detect it.",
  },
  {
    status: "Denied",
    event: "bot.stopped",
    terminal: true,
    meaning: "A host explicitly denied the bot entry.",
    note: "On Zoom this interacts with recording_permission_denied_timeout (60 to 300s).",
  },
  {
    status: "Error",
    event: "bot.stopped",
    terminal: true,
    meaning: "The session failed. No usable recording.",
    note: "GET /bots/{id}/detail carries the reason.",
  },
  {
    status: "Done",
    event: "bot.done",
    terminal: true,
    meaning: "The session finished and all post-processing completed.",
    note: "Streaming-only transcription providers never reach this. They end at audio.processed.",
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
  ["audio.processed", "Audio is ready. Streaming-only providers END here."],
  ["transcription.processed", "The post-call transcript is ready to fetch."],
  ["transcription.failed", "Transcription failed. This one carries status_code 500."],
  ["video.processed", "Video is ready (only when video_required was true)."],
  ["bot.done", "Everything finished. bot_status becomes Done."],
  ["data_deletion", "The bot's media and transcripts were erased."],
];

export function describe(status) {
  return STATUSES.find((s) => s.status === status) ?? null;
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
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
  console.log("  1. The webhook envelope key is `event`, not `bot_event`.");
  console.log("  2. bot.stopped is status_code 200 even for Denied, NotAllowed and Error.");
  console.log("  3. bot.error is NOT terminal. It reports a streaming provider fault");
  console.log("     while the bot keeps running.");
  console.log("  4. transcript_id never appears in a webhook. Read it from the");
  console.log("     create_bot response, GET /bots/{id}/detail, or /transcriptions.");
  console.log("");
}
