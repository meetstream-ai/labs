function loadConfig() {
  const config = {
    apiKey: readRequired("MEETSTREAM_API_KEY"),
    agentConfigId: readRequired("MEETSTREAM_AGENT_CONFIG_ID"),
    meetingLink: readRequired("MEETING_LINK"),
    callbackUrl: readOptional("CALLBACK_URL"),
    ngrokAuthtoken: readOptional("NGROK_AUTHTOKEN"),
    port: Number.parseInt(process.env.PORT || "3000", 10),
    botName: process.env.BOT_NAME || "MIA Hello World Voice Agent",
  };

  if (!Number.isInteger(config.port) || config.port <= 0) {
    fail("PORT must be a positive integer.");
  }

  if (!config.callbackUrl && !config.ngrokAuthtoken) {
    fail("Set either CALLBACK_URL or NGROK_AUTHTOKEN.");
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
