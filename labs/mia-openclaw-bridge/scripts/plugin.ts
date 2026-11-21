import { settingsFromEnv, startBridgeServer } from "../src/server.js";

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const settings = settingsFromEnv();
if (!settings.apiKey) {
  throw new Error("BRIDGE_API_KEY is required in plugin mode so bridge management calls are authenticated");
}

const running = await startBridgeServer(settings);
console.log(`MeetStream plugin ready at ${running.publicUrl}`);

let stopPromise: Promise<void> | undefined;
const stop = () => {
  stopPromise ??= running.stop();
  return stopPromise;
};

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
