require("dotenv").config();

const { loadConfig } = require("./src/config");
const { createBot, removeBot } = require("./src/meetstream");
const { startTunnel } = require("./src/tunnel");
const { startWebhookServer } = require("./src/webhook-server");

async function main() {
  const config = loadConfig();
  const server = startWebhookServer({
    port: config.port,
    onEvent: (event) => {
      if (event.bot_id) activeBotId = event.bot_id;
    },
  });

  let tunnel;
  let activeBotId;

  try {
    tunnel = config.callbackUrl ? undefined : await startTunnel(config.port);
    const publicUrl = config.callbackUrl ?? tunnel.url;
    const callbackUrl = `${publicUrl.replace(/\/$/, "")}/webhooks/meetstream`;

    const bot = await createBot({
      apiKey: config.apiKey,
      meetingLink: config.meetingLink,
      agentConfigId: config.agentConfigId,
      botName: config.botName,
      callbackUrl,
      customAttributes: {
        example: "mia-hello-world-voice-agent",
      },
    });

    activeBotId = bot.botId;

    console.log("\nMIA hello-world voice agent is live.");
    console.log(`  bot_id   : ${bot.botId}`);
    console.log(`  callback : ${callbackUrl}`);
    console.log("\nAddress the agent in the meeting using the wake phrase configured in Dashboard.");
    console.log("Press Ctrl+C to remove the bot and exit.\n");
  } catch (error) {
    console.error("\nFailed to start the MIA hello-world voice agent:");
    console.error(formatError(error));
    await shutdown({ server, tunnel, apiKey: config.apiKey, botId: activeBotId });
    process.exit(1);
  }

  async function handleExit() {
    await shutdown({ server, tunnel, apiKey: config.apiKey, botId: activeBotId });
    process.exit(0);
  }

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
}

async function shutdown({ server, tunnel, apiKey, botId }) {
  console.log("\nShutting down...");

  if (botId) {
    try {
      await removeBot({ apiKey, botId });
      console.log(`Removed bot ${botId}.`);
    } catch (error) {
      console.warn(`Could not remove bot ${botId}: ${formatError(error)}`);
    }
  }

  if (tunnel?.close) {
    await tunnel.close().catch(() => {});
  }

  if (server?.close) {
    await new Promise((resolve) => server.close(resolve));
  }
}

function formatError(error) {
  if (error?.details) return JSON.stringify(error.details, null, 2);
  return error?.message ?? String(error);
}

main();
