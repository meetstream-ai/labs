function loadConfig() {
  const config = {
    apiKey: readRequired("MEETSTREAM_API_KEY"),
    meetingLink: readRequired("MEETING_LINK"),
    realtimeAgentConfigId: readRequired("REALTIME_AGENT_CONFIG_ID"),
    pipelineAgentConfigId: readRequired("PIPELINE_AGENT_CONFIG_ID"),
    callbackUrl: readOptional("CALLBACK_URL"),
    ngrokAuthtoken: readOptional("NGROK_AUTHTOKEN"),
    port: Number.parseInt(process.env.PORT || "3001", 10),
    realtimeBotName: process.env.REALTIME_BOT_NAME || "MIA Realtime Agent",
    pipelineBotName: process.env.PIPELINE_BOT_NAME || "MIA Pipeline Agent",
  };

  if (!Number.isInteger(config.port) || config.port <= 0) {
    fail("PORT must be a positive integer.");
  }

  if (!config.callbackUrl && !config.ngrokAuthtoken) {
    fail("Set either CALLBACK_URL or NGROK_AUTHTOKEN.");
  }

  if (config.realtimeAgentConfigId === config.pipelineAgentConfigId) {
    fail("REALTIME_AGENT_CONFIG_ID and PIPELINE_AGENT_CONFIG_ID must be different saved agents.");
  }

  return config;
}

function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

function readOptional(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function fail(message) {
  console.error(`Configuration error: ${message}`);
  process.exit(1);
}

module.exports = { loadConfig };
