const axios = require("axios");

const API_BASE = "https://api.meetstream.ai/api/v1";
const WEBHOOK_PORT = process.env.PORT || 3000;

/**
 * Creates a MeetStream bot that joins a meeting and records a post-call transcript.
 *
 * The bot is configured with:
 *   - MeetStream's own transcription provider (no extra API key needed)
 *   - A callback_url pointing to our local webhook server
 *
 * After the call, MeetStream will POST `transcription.processed` to our webhook,
 * at which point we automatically fetch and display the full transcript.
 *
 * @param {string} meetingLink  Full Zoom / Google Meet / Teams meeting URL
 * @returns {Promise<{ bot_id: string, transcript_id: string }>}
 */
async function createBot(meetingLink) {
  const webhookUrl =
    process.env.WEBHOOK_URL || `http://localhost:${WEBHOOK_PORT}/webhook`;

  console.log("\n  Creating MeetStream bot...");
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

    // Store for the webhook handler to pick up
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
