import { checkConnectivity, loadLocalConfig } from "../src/config.js";
import { startBridgeServer } from "../src/server.js";
import { spawn } from "node:child_process";

let running: Awaited<ReturnType<typeof startBridgeServer>> | undefined;

try {
  try { process.loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { input, warnings } = await loadLocalConfig(process.argv[2]);
  for (const warning of warnings) console.warn(`Warning: ${warning}`);

  console.log("MeetStream Labs — Hermes meeting agent");
  console.log(`Meeting: ${input.meeting_url}`);
  console.log("Checking MeetStream and Hermes…");
  await checkConnectivity(input);
  console.log("Starting bridge and public tunnel…");
  running = await startBridgeServer();
  console.log(`Public bridge: ${running.publicUrl}`);
  console.log("Creating or selecting the MIA configuration and sending the bot…");
  const session = await running.bridge.create(input);
  const guard = spawn(process.execPath, ["--import", "tsx", "scripts/cleanup-guard.ts", session.botId!, String(process.pid)], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  guard.unref();
  console.log(`Bot created: ${session.botId}`);
  console.log("Admit “Hermes Meeting Agent” if it enters the waiting room, then speak to it.");
  console.log("Press Ctrl+C to remove the bot and stop safely.\n");

  let previous = "";
  const timer = setInterval(() => {
    const view = running!.bridge.view(session);
    const snapshot = JSON.stringify({
      state: view.state,
      event: view.lifecycle_event,
      turns: view.transport.finalized_turns,
      answers: view.transport.hermes_responses,
      error: view.last_error
    });
    if (snapshot !== previous) {
      previous = snapshot;
      console.log(`[status] ${view.state} | heard ${view.transport.finalized_turns} | answered ${view.transport.hermes_responses}` +
        (view.last_error ? ` | ${view.last_error}` : ""));
    }
  }, 750);
  timer.unref();

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
    console.log("\nRemoving bot and closing bridge…");
    await running?.stop();
    console.log("Stopped.");
    })();
    return stopPromise;
  };
  await new Promise<void>((resolve) => {
    const finish = () => void stop().finally(resolve);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
} catch (error) {
  await running?.stop();
  console.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run npm run doctor for a read-only configuration check.");
  process.exitCode = 1;
}
