const { request } = require("./client");
const state = require("./state");

/**
 * Creates a MeetStream bot that joins a meeting and records a post-call transcript.
 *
 * `meeting_link` and `bot_name` are both required by create_bot. The response
 * carries `transcript_id`; keep it, because webhooks never include it.
 *
 * @param {string} meetingLink   Full Zoom / Google Meet / Teams meeting URL
 * @param {string} webhookUrl    Public URL MeetStream will POST events to
 * @returns {Promise<{ bot_id: string, transcript_id: string|null }>}
 */
async function createBot(meetingLink, webhookUrl) {
  console.log("  Creating MeetStream bot...");
  console.log(`   Meeting : ${meetingLink}`);
  console.log(`   Webhook : ${webhookUrl}\n`);

  try {
    const { status, data } = await request("/bots/create_bot", {
      method: "POST",
      body: {
        meeting_link: meetingLink,
        bot_name: process.env.BOT_NAME || "MeetStream Transcription Bot",
        // Audio only. `false` is sent explicitly because the REST API treats an
        // omitted `video_required` as true. Video is opt-in, and when it is on
        // the payload must also carry recording_config.video_layout: "speaker_view".
        video_required: false,
        callback_url: webhookUrl,
        recording_config: {
          transcript: {
            // A post-call provider. Streaming providers (*_streaming,
            // meeting_captions) never produce a post-call transcript.
            provider: {
              meetstream: {
                language: "auto",
                translate: false,
              },
            },
          },
        },
      },
    });

    const botId = data?.bot_id ?? data?.id;
    const transcriptId = data?.transcript_id ?? null;

    console.log(status === 507 ? "  Idempotent replay (HTTP 507) - reusing the existing bot." : "  Bot created successfully!");
    console.log(`   bot_id        : ${botId}`);
    console.log(
      `   transcript_id : ${transcriptId ?? "(not returned - will be looked up on GET /bots/{id}/detail)"}`
    );
    console.log("\n  Waiting for the meeting to end...\n");

    state.botId = botId;
    state.transcriptId = transcriptId;

    return { bot_id: botId, transcript_id: transcriptId };
  } catch (err) {
    console.error(`  Failed to create bot: ${err.message}`);
    if (err.body && typeof err.body === "object") console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
}

module.exports = { createBot };
