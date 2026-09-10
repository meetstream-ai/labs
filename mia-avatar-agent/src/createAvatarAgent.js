import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request, requireEnv } from "./http.js";

const defaultConfigPath = fileURLToPath(new URL("../agent.config.json", import.meta.url));

// Creates a MIA agent from agent.config.json with the Anam avatar attached.
// Returns an agent_config_id you pass to create_bot to deploy the avatar
// into a meeting.
//
// agent.config.json is a plain MIA agent config -- copy any example
// straight from MeetStream's reference (pipeline or realtime, any model
// provider) and it works as-is: https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config
// This script only adds the Avatar block on top; it doesn't try to
// reconstruct or guess provider-specific fields for you.
export async function createAvatarAgent() {
  const meetstreamApiKey = requireEnv("MEETSTREAM_API_KEY");
  const avatarId = requireEnv("ANAM_AVATAR_ID");

  const configPath = process.env.MIA_AGENT_CONFIG_FILE || defaultConfigPath;
  const agentConfig = JSON.parse(readFileSync(configPath, "utf8"));

  const body = {
    ...agentConfig,
    // Top-level `Avatar` (capitalized) matches MeetStream's own reference
    // and response payloads: https://docs.meetstream.ai/api-reference/api-endpoints/mia/create-agent-config
    Avatar: {
      provider: process.env.ANAM_AVATAR_PROVIDER || "anam",
      enabled: true,
      avatar_id: avatarId,
      ...(process.env.ANAM_AVATAR_MODEL && {
        avatar_model: process.env.ANAM_AVATAR_MODEL,
      }),
      ...(process.env.ANAM_AVATAR_NAME && {
        name: process.env.ANAM_AVATAR_NAME,
      }),
    },
  };

  const agent = await request("https://api.meetstream.ai/api/v1/mia", {
    method: "POST",
    headers: {
      Authorization: `Token ${meetstreamApiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });

  console.log("Created a new MIA avatar agent on your MeetStream account:");
  console.log(JSON.stringify(agent, null, 2));
  console.log(
    `\nThis agent_config_id is yours, not a shared/global one. Paste it into your own .env as:\n` +
      `  MIA_AGENT_CONFIG_ID=${agent.agent_config_id}\n` +
      `so future runs reuse this same agent instead of creating a new one every time.`
  );

  return agent;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAvatarAgent().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
