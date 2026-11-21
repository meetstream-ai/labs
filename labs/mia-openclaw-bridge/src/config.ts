import { readFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createSessionSchema, type CreateSessionInput } from "./schema.js";

export async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(path, "utf8");
    return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
      const value = line.trim();
      if (!value || value.startsWith("#") || !value.includes("=")) return [];
      const index = value.indexOf("=");
      const key = value.slice(0, index).trim();
      let entry = value.slice(index + 1).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) ||
          (entry.startsWith("'") && entry.endsWith("'"))) entry = entry.slice(1, -1);
      return [[key, entry]];
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export type LocalConfig = {
  env: Record<string, string>;
  input: CreateSessionInput;
  warnings: string[];
};

export async function checkConnectivity(
  input: CreateSessionInput,
  request: typeof fetch = fetch
): Promise<void> {
  const [meetstream, openclaw] = await Promise.all([
    request(`${input.meetstream.base_url.replace(/\/$/, "")}/api/v1/mia`, {
      headers: { Authorization: `Token ${input.meetstream.api_key}` },
      signal: AbortSignal.timeout(15_000)
    }),
    request(`${input.openclaw.base_url.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${input.openclaw.api_key}` },
      signal: AbortSignal.timeout(15_000)
    })
  ]);
  if (!meetstream.ok) throw new Error(`MeetStream authentication failed (HTTP ${meetstream.status})`);
  if (!openclaw.ok) throw new Error(`OpenClaw Gateway check failed (HTTP ${openclaw.status})`);
}

export async function loadLocalConfig(meetingUrlOverride?: string): Promise<LocalConfig> {
  const file = await readEnvFile(resolve(".env"));
  const env = { ...file, ...process.env } as Record<string, string>;
  const warnings: string[] = [];
  const meetingUrl = meetingUrlOverride || env.MEETING_URL;
  const meetstreamKey = env.MEETSTREAM_API_KEY;
  const openclawKey = env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_GATEWAY_PASSWORD;

  if (!meetingUrl) throw new Error("Set MEETING_URL in .env or pass a meeting URL after --");
  if (!meetstreamKey) throw new Error("MEETSTREAM_API_KEY is missing from .env");
  if (!openclawKey) throw new Error("Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD in .env");

  const output = env.OUTPUT_MODE || "chat";
  const rawWakeWords = env.WAKE_WORDS?.trim();
  // `off` is the explicit opt-out. A missing or blank value keeps the safe defaults.
  const wakeWords = rawWakeWords === "off"
    ? []
    : rawWakeWords
      ? rawWakeWords.split(",").map((word) => word.trim()).filter(Boolean)
      : undefined;
  const speech = output === "chat" ? undefined : {
    base_url: env.SPEECH_BASE_URL || "https://api.openai.com/v1",
    api_key: env.SPEECH_API_KEY,
    model: env.SPEECH_MODEL || "tts-1",
    voice: env.SPEECH_VOICE || "alloy",
    sample_rate: Number(env.SPEECH_SAMPLE_RATE || 24000)
  };

  return {
    env,
    warnings,
    input: createSessionSchema.parse({
      meeting_url: meetingUrl,
      openclaw: {
        base_url: env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789/v1",
        api_key: openclawKey,
        model: env.OPENCLAW_MODEL || "openclaw/default",
        mode: env.OPENCLAW_API_MODE || "chat_completions",
        ...(env.OPENCLAW_INSTRUCTIONS ? { instructions: env.OPENCLAW_INSTRUCTIONS } : {})
      },
      meetstream: {
        base_url: env.MEETSTREAM_BASE_URL || "https://api.meetstream.ai",
        api_key: meetstreamKey,
        mia: env.MEETSTREAM_MIA_CONFIG_ID
          ? { agent_config_id: env.MEETSTREAM_MIA_CONFIG_ID, reuse_by_name: true }
          : { reuse_by_name: true },
        bot_name: env.BOT_NAME || "OpenClaw Meeting Agent",
        video_required: false
      },
      ...(wakeWords ? { wake_words: wakeWords } : {}),
      output,
      ...(speech ? { speech } : {})
    })
  };
}

export async function createEnvFile(): Promise<boolean> {
  try {
    await copyFile(resolve(".env.example"), resolve(".env"), 1);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
