import "dotenv/config";
import { createAvatarAgent } from "./createAvatarAgent.js";
import { deployBot } from "./deployBot.js";

// End-to-end: reuse MIA_AGENT_CONFIG_ID if set, otherwise create a fresh
// avatar agent, then join it to MEETING_LINK.
async function main() {
  const agentConfigId =
    process.env.MIA_AGENT_CONFIG_ID || (await createAvatarAgent()).agent_config_id;

  await deployBot(agentConfigId);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
