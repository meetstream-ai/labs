const API_BASE = "https://api.meetstream.ai/api/v1";

async function createBot({
  apiKey,
  meetingLink,
  agentConfigId,
  botName,
  callbackUrl,
  customAttributes = {},
}) {
  const payload = {
    meeting_link: meetingLink,
    bot_name: botName,
    video_required: false,
    agent_config_id: agentConfigId,
    callback_url: callbackUrl,
    custom_attributes: customAttributes,
  };

  console.log("Creating MeetStream bot...");
  console.log(`  meeting : ${meetingLink}`);
  console.log(`  agent   : ${agentConfigId}`);
  console.log(`  callback: ${callbackUrl}`);

  const data = await request(apiKey, "POST", "/bots/create_bot", payload);
  const botId = data.bot_id ?? data.id;

  if (!botId) {
    const error = new Error("MeetStream did not return bot_id.");
    error.details = data;
    throw error;
  }

  return { botId, raw: data };
}

async function removeBot({ apiKey, botId }) {
  return request(apiKey, "GET", `/bots/${botId}/remove`);
}

async function request(apiKey, method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await safeJson(response);

  if (!response.ok) {
    const error = new Error(`MeetStream API request failed (${response.status}).`);
    error.details = data;
    throw error;
  }

  return data;
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = { createBot, removeBot };
