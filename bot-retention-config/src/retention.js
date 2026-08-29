/**
 * Building and explaining `recording_config.retention`.
 *
 * Retention is set once, at bot creation. There is no endpoint that changes the
 * window on an existing bot, so the value you send with create_bot is the value
 * that bot lives with.
 */

/** The API's own default when no retention block is sent. */
export const DEFAULT_RETENTION_HOURS = 24;

/**
 * Builds `recording_config` for the chosen mode.
 *
 *   mode "timed"    send { type: "timed", hours: N } and keep artifacts N hours
 *   mode "default"  send no retention block at all and inherit the API default
 *
 * "default" is not a value you put in `type`. The only documented retention
 * type is "timed". Inheriting the default means omitting the block.
 */
export function buildRecordingConfig({ mode, hours, transcript }) {
  const recordingConfig = {};

  if (transcript) {
    recordingConfig.transcript = {
      provider: {
        deepgram: { model: "nova-3", language: "en" },
      },
    };
  }

  if (mode === "timed") {
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error(`--hours must be a positive number, got: ${hours}`);
    }
    recordingConfig.retention = { type: "timed", hours };
  }

  // mode "default": deliberately no retention key.
  return Object.keys(recordingConfig).length > 0 ? recordingConfig : null;
}

export function describeMode(mode, hours) {
  if (mode === "timed") {
    return [
      `Retention: timed, ${hours} hours.`,
      `Everything this bot records is deleted about ${hours} hours after the session.`,
      hours > DEFAULT_RETENTION_HOURS
        ? `That is longer than the API default of ${DEFAULT_RETENTION_HOURS} hours.`
        : hours < DEFAULT_RETENTION_HOURS
          ? `That is shorter than the API default of ${DEFAULT_RETENTION_HOURS} hours.`
          : `That matches the API default of ${DEFAULT_RETENTION_HOURS} hours.`,
    ];
  }

  return [
    "Retention: account default.",
    "No retention block is sent, so the bot inherits the API default of",
    `${DEFAULT_RETENTION_HOURS} hours (unless your workspace is configured otherwise).`,
  ];
}

export function printExplainer() {
  console.log(`
RETENTION SEMANTICS
${"=".repeat(68)}

Where it goes
  create_bot body:
    {
      "meeting_link": "...",
      "recording_config": {
        "retention": { "type": "timed", "hours": 72 }
      }
    }

  It is nested under recording_config, alongside transcript. It is not a
  top-level create_bot field.

The two modes
  timed     { "type": "timed", "hours": N }
            Artifacts are kept for N hours after the session, then removed.

  default   Send no retention block. The bot inherits the API default of
            ${DEFAULT_RETENTION_HOURS} hours. There is no type: "default";
            "timed" is the only documented type.

What actually expires
  - the audio recording            GET /bots/{id}/get_audio
  - the video recording            GET /bots/{id}/get_video
  - per-participant streams        get_audio_streams, get_recording_streams
  - screenshots                    GET /bots/{id}/get_screenshots
  - the transcript                 GET /transcript/{transcript_id}/get_transcript

  Once the window closes those artifacts are gone the same way they are gone
  after DELETE /bots/{id}/delete. Fetch and store anything you need to keep
  before the window closes. Retention is not a backup policy, it is a delete
  timer.

When to change it
  Shorter than default   sensitive calls, or a pipeline that pulls the
                         recording within minutes and does not want a copy
                         sitting on someone else's disk.
  Longer than default    human review queues, weekly QA sampling, anything
                         where a person may not look at the call until days
                         later.

Timing you can rely on
  The clock starts when the session finishes, not when the bot was created.
  Expiry is asynchronous, so treat the window as "at least N hours", not as a
  precise deadline you can schedule against.

Related, and often confused
  Retention expiry      automatic, time based, set at creation
  DELETE /bots/{id}/delete   manual, immediate, irreversible, and the
                        documented trigger for the data_deletion webhook
  GET /bots/{id}/remove_bot  makes the bot leave a live meeting and deletes
                        nothing at all
`);
}
