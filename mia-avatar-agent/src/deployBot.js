import "dotenv/config";
import { pathToFileURL } from "node:url";
import { request, requireEnv } from "./http.js";

// Deploys a bot carrying the given agent_config_id into a live meeting. When
// the agent has avatar.enabled=true, the avatar renders on the bot's tile
// and lip-syncs to every TTS response.
export async function deployBot(agentConfigId) {
  const meetstreamApiKey = requireEnv("MEETSTREAM_API_KEY");
  const meetingLink = requireEnv("MEETING_LINK");

  const bot = await request(
    "https://api.meetstream.ai/api/v1/bots/create_bot",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${meetstreamApiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        meeting_link: meetingLink,
        agent_config_id: agentConfigId,
        // Despite MeetStream's docs saying this defaults to true, bots
        // created without it come back with video_required: false, and the
        // avatar has no video track to render on -- must be set explicitly.
        video_required: true,
      },
    }
  );

  console.log("Bot deployed:");
  console.log(JSON.stringify(bot, null, 2));

  return bot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agentConfigId = requireEnv("MIA_AGENT_CONFIG_ID");
  deployBot(agentConfigId).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
