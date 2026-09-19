require("dotenv").config();

if (["--help", "-h", "help"].includes(process.argv[2])) {
  console.log(
    [
      "Usage: node index.js        (configured entirely through .env)",
      "",
      "Sends a MeetStream bot into MEETING_LINK, receives the lifecycle webhooks",
      "through an ngrok tunnel, and saves the post-call transcript to ./transcripts/.",
      "",
      "Required env: MEETSTREAM_API_KEY, MEETING_LINK, NGROK_AUTHTOKEN.",
      "See .env.example for every option.",
    ].join("\n")
  );
  process.exit(0);
}

const { startTunnel } = require("./src/tunnel");
const { createBot } = require("./src/bot");
const { startWebhookServer } = require("./src/webhook");

const PORT = parseInt(process.env.PORT || "3000", 10);
const MEETING_LINK = process.env.MEETING_LINK;

// Fail fast on config before touching the network.
if (!process.env.MEETSTREAM_API_KEY) {
  console.error("  MEETSTREAM_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!MEETING_LINK) {
  console.error("  MEETING_LINK is not set in your .env file.");
  process.exit(1);
}

(async () => {
  try {
    // 1. Start ngrok tunnel -> get public URL automatically
    const tunnelUrl = await startTunnel(PORT);
    const webhookUrl = `${tunnelUrl}/webhook`;

    // 2. Start local webhook server
    startWebhookServer(PORT, () => {
      // 3. Deploy the bot with the live tunnel URL as callback
      createBot(MEETING_LINK, webhookUrl);
    });
  } catch (err) {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
})();
