import { checkConnectivity, loadLocalConfig } from "../src/config.js";

const ok = (message: string) => console.log(`✓ ${message}`);
const fail = (message: string) => console.error(`✗ ${message}`);

try {
  const { env, input, warnings } = await loadLocalConfig(process.argv[2]);
  ok(`Node ${process.versions.node}`);
  ok(`Meeting URL (${new URL(input.meeting_url).hostname})`);
  ok("MeetStream API key is configured");
  ok("Hermes API key is configured");
  if (env.PUBLIC_BASE_URL) ok(`Public bridge URL (${new URL(env.PUBLIC_BASE_URL).hostname})`);
  else if (env.NGROK_AUTHTOKEN) ok("ngrok authtoken is configured");
  else throw new Error("Set PUBLIC_BASE_URL or NGROK_AUTHTOKEN in .env");
  for (const warning of warnings) console.warn(`! ${warning}`);

  await checkConnectivity(input);
  ok("MeetStream API is reachable and authenticated");
  ok("Hermes gateway is reachable and authenticated");
  console.log("\nReady. Run npm start to send Hermes into the meeting.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  console.error("Run npm run setup if .env does not exist, then fix the value above.");
  process.exitCode = 1;
}
