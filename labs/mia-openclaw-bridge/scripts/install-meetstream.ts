import { defaultMia } from "../src/schema.js";

type InstallOptions = {
  baseUrl: string;
  apiKey: string;
  agentConfigId?: string;
};

type JsonObject = Record<string, unknown>;

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  let body: JsonObject;
  try {
    body = text ? JSON.parse(text) as JsonObject : {};
  } catch {
    throw new Error(`MeetStream returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(`MeetStream returned HTTP ${response.status}`);
  return body;
}

export async function ensureMeetStreamAgent(
  options: InstallOptions,
  request: typeof fetch = fetch
): Promise<{ id: string; created: boolean }> {
  const base = options.baseUrl.replace(/\/$/, "");
  const call = (path: string, init: RequestInit = {}) => request(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${options.apiKey}`,
      "Content-Type": "application/json",
      ...init.headers
    },
    signal: init.signal ?? AbortSignal.timeout(30_000)
  });

  if (options.agentConfigId) {
    await readJson(await call(`/api/v1/mia?agent_config_id=${encodeURIComponent(options.agentConfigId)}`));
    return { id: options.agentConfigId, created: false };
  }

  const listed = await readJson(await call("/api/v1/mia"));
  const configurations = Array.isArray(listed.agent_configs) ? listed.agent_configs : [];
  const existing = configurations.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const value = candidate as JsonObject;
    return value.AgentName === defaultMia.agent_name || value.agent_name === defaultMia.agent_name;
  }) as JsonObject | undefined;
  const existingId = existing?.AgentConfigID ?? existing?.agent_config_id;
  if (typeof existingId === "string") return { id: existingId, created: false };

  const created = await readJson(await call("/api/v1/mia", {
    method: "POST",
    body: JSON.stringify(defaultMia)
  }));
  const nested = created.agent_config as JsonObject | undefined;
  const id = created.agent_config_id ?? nested?.AgentConfigID ?? nested?.agent_config_id;
  if (typeof id !== "string") throw new Error("MeetStream response omitted agent_config_id");
  return { id, created: true };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const apiKey = process.env.MEETSTREAM_API_KEY;
  if (!apiKey) throw new Error("MEETSTREAM_API_KEY is required in .env");
  const result = await ensureMeetStreamAgent({
    baseUrl: process.env.MEETSTREAM_BASE_URL ?? "https://api.meetstream.ai",
    apiKey,
    agentConfigId: process.env.MEETSTREAM_MIA_CONFIG_ID || undefined
  });
  console.log(`${result.created ? "Created" : "Using"} MeetStream MIA configuration: ${result.id}`);
  console.log(`Set MEETSTREAM_MIA_CONFIG_ID=${result.id} in .env for deterministic reuse.`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
