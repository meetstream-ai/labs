const axios = require("axios");

const API_BASE = "https://api.meetstream.ai/api/v1";

/**
 * Creates a MeetStream bot that joins a meeting and records a post-call transcript.
 *
 * @param {string} meetingLink   Full Zoom / Google Meet / Teams meeting URL
 * @param {string} webhookUrl    Public URL MeetStream will POST events to
 * @returns {Promise<{ bot_id: string, transcript_id: string }>}
 */
async function createBot(meetingLink, webhookUrl) {
  console.log("  Creating MeetStream bot...");
  console.log(`   Meeting : ${meetingLink}`);
  console.log(`   Webhook : ${webhookUrl}\n`);

  try {
    const { data } = await axios.post(
      `${API_BASE}/bots/create_bot`,
      {
        meeting_link: meetingLink,
        video_required: false,
        callback_url: webhookUrl,
        recording_config: {
          transcript: {
            provider: {
              meetstream: {
                language: "auto",
                translate: false,
              },
            },
          },
        },
      },
      {
        headers: {
          Authorization: `Token ${process.env.MEETSTREAM_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const botId = data?.bot_id ?? data?.id;
    const transcriptId = data?.transcript_id;

    console.log("  Bot created successfully!");
    console.log(`   bot_id        : ${botId}`);
    console.log(`   transcript_id : ${transcriptId ?? "(will arrive in webhook)"}`);
    console.log("\n  Waiting for the meeting to end...\n");

    process.env._BOT_ID = botId;
    process.env._TRANSCRIPT_ID = transcriptId ?? "";

    return { bot_id: botId, transcript_id: transcriptId };
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ?? err.message;
    console.error(`  Failed to create bot (HTTP ${status}):`);
    console.error(JSON.stringify(detail, null, 2));
    process.exit(1);
  }
}

module.exports = { createBot };
