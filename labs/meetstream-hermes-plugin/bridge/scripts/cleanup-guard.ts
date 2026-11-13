/**
 * Removes one bot if its launcher process disappears before normal cleanup finishes.
 * It is deliberately detached from the launcher so terminal/process-group shutdown
 * cannot leave a meeting bot behind.
 */
const [botId, parentPidText] = process.argv.slice(2);
const parentPid = Number(parentPidText);
const apiKey = process.env.MEETSTREAM_API_KEY || process.env.MIA_HERMES_API_KEY;
const baseUrl = (process.env.MEETSTREAM_BASE_URL || "https://api.meetstream.ai").replace(/\/$/, "");

if (!botId || !Number.isInteger(parentPid) || !apiKey) process.exit(0);

function parentIsRunning(): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

while (parentIsRunning()) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

await fetch(`${baseUrl}/api/v1/bots/${encodeURIComponent(botId)}/remove_bot`, {
  headers: { Authorization: `Token ${apiKey}` },
  signal: AbortSignal.timeout(15_000)
}).catch(() => undefined);
