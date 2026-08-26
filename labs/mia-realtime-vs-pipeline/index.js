require("dotenv").config();

const { loadConfig } = require("./src/config");
const { createBot, removeBot } = require("./src/meetstream");
const { createComparisonTracker } = require("./src/comparison");
const { startTunnel } = require("./src/tunnel");
const { startWebhookServer } = require("./src/webhook-server");

async function main() {
  const config = loadConfig();
  const tracker = createComparisonTracker();
  const activeBots = new Map();

  const server = startWebhookServer({
    port: config.port,
    onEvent: (event) => tracker.record(event),
  });

  let tunnel;

  try {
    tunnel = config.callbackUrl ? undefined : await startTunnel(config.port);
    const publicUrl = config.callbackUrl ?? tunnel.url;
    const callbackUrl = `${publicUrl.replace(/\/$/, "")}/webhooks/meetstream`;

    const botSpecs = [
      {
        mode: "realtime",
        label: "Realtime",
        agentConfigId: config.realtimeAgentConfigId,
        botName: config.realtimeBotName,
      },
      {
        mode: "pipeline",
        label: "Pipeline",
        agentConfigId: config.pipelineAgentConfigId,
        botName: config.pipelineBotName,
      },
    ];

    for (const spec of botSpecs) {
      const bot = await createBot({
        apiKey: config.apiKey,
        meetingLink: config.meetingLink,
        agentConfigId: spec.agentConfigId,
        botName: spec.botName,
        callbackUrl,
        customAttributes: {
          example: "mia-realtime-vs-pipeline",
          mode: spec.mode,
        },
      });

      activeBots.set(spec.mode, bot.botId);
      tracker.registerBot({ mode: spec.mode, label: spec.label, botId: bot.botId });
    }

    console.log("\nRealtime vs pipeline run started.");
    console.log(`  callback : ${callbackUrl}`);
    console.log(`  realtime : ${activeBots.get("realtime")}`);
    console.log(`  pipeline : ${activeBots.get("pipeline")}`);
    console.log("\nPrompt both agents with the same request in the meeting.");
    console.log("Press Ctrl+C to remove both bots and print the comparison summary.\n");
  } catch (error) {
    console.error("\nFailed to start realtime-vs-pipeline comparison:");
    console.error(formatError(error));
    await shutdown({ server, tunnel, apiKey: config.apiKey, activeBots, tracker });
    process.exit(1);
  }

  async function handleExit() {
    await shutdown({ server, tunnel, apiKey: config.apiKey, activeBots, tracker });
    process.exit(0);
  }

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
}

async function shutdown({ server, tunnel, apiKey, activeBots, tracker }) {
  console.log("\nShutting down...");

  for (const [mode, botId] of activeBots.entries()) {
    try {
      await removeBot({ apiKey, botId });
      console.log(`Removed ${mode} bot ${botId}.`);
    } catch (error) {
      console.warn(`Could not remove ${mode} bot ${botId}: ${formatError(error)}`);
    }
  }

  tracker.printSummary();

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
