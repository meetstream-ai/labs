require("dotenv").config();
const { createBot } = require("./src/bot");
const { startWebhookServer } = require("./src/webhook");

const MEETING_LINK = process.env.MEETING_LINK;

if (!MEETING_LINK) {
  console.error("  MEETING_LINK is not set in your .env file.");
  process.exit(1);
}

// Start the webhook listener first, then deploy the bot.
startWebhookServer(() => {
  createBot(MEETING_LINK);
});
