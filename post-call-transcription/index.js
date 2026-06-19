require("dotenv").config();
const { startTunnel } = require("./src/tunnel");
const { createBot } = require("./src/bot");
const { startWebhookServer } = require("./src/webhook");

const PORT = parseInt(process.env.PORT || "3000", 10);
const MEETING_LINK = process.env.MEETING_LINK;

if (!MEETING_LINK) {
  console.error("  MEETING_LINK is not set in your .env file.");
  process.exit(1);
}

(async () => {
  // 1. Start ngrok tunnel → get public URL automatically
  const tunnelUrl = await startTunnel(PORT);
  const webhookUrl = `${tunnelUrl}/webhook`;

  // 2. Start local webhook server
  startWebhookServer(PORT, () => {
    // 3. Deploy the bot with the live tunnel URL as callback
    createBot(MEETING_LINK, webhookUrl);
  });
})();
