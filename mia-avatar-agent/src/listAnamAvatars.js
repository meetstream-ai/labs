import "dotenv/config";
import { request, requireEnv } from "./http.js";

// Anam has both persona_ids and avatar_ids (both UUIDs). MeetStream needs the
// avatar_id specifically -- this lists what's on your Anam account so you can
// grab the right one for ANAM_AVATAR_ID.
async function main() {
  const anamApiKey = requireEnv("ANAM_API_KEY");

  const avatars = await request("https://api.anam.ai/v1/avatars", {
    headers: { Authorization: `Bearer ${anamApiKey}` },
  });

  const list = Array.isArray(avatars) ? avatars : avatars.data ?? [];
  if (list.length === 0) {
    console.log("No avatars found on this Anam account.");
    return;
  }

  console.log(`Found ${list.length} avatar(s) (showing this page):\n`);
  for (const avatar of list) {
    console.log(`- avatar_id: ${avatar.id}`);
    if (avatar.displayName) console.log(`  name: ${avatar.displayName}`);
  }
  console.log("\nSet ANAM_AVATAR_ID in .env to one of the ids above.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
