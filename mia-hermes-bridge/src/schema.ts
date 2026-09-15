import { z } from "zod";

const url = z.string().url();
const secret = z.string().min(1);
const object = z.record(z.unknown());

export const defaultWakeWords = ["hey assistant", "hey hermes", "hey bot", "okay agent", "okay bot"] as const;

export const defaultMia = {
  agent_name: "Hermes External Runtime",
  mode: "pipeline" as const,
  model: {
    provider: "openai",
    model: "gpt-4.1-mini",
    system_prompt: "Transport-only configuration. Do not generate a participant-facing response.",
    temperature: 0,
    max_tokens: 32
  },
  voice: { provider: "openai", voice_id: "alloy", model: "tts-1" },
  transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
  agent: {
    response_type: "action",
    response_modality: "none",
    tools: [],
    preemptive_generation: false
  },
  audio: { sample_rate: 24000, num_channels: 1 }
};

const miaCreate = z.object({
  agent_name: z.string().min(1).default(defaultMia.agent_name),
  mode: z.literal("pipeline").default("pipeline"),
  model: object.default(defaultMia.model),
  voice: object.default(defaultMia.voice),
  transcriber: object.default(defaultMia.transcriber),
  agent: object.default(defaultMia.agent),
  audio: object.default(defaultMia.audio),
  wake_word: object.optional()
});

export const createSessionSchema = z.object({
  meeting_url: url.refine((value) => {
    const host = new URL(value).hostname.toLowerCase();
    return host === "meet.google.com" || host === "zoom.us" || host.endsWith(".zoom.us") ||
      host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com");
  }, "meeting_url must be a Google Meet, Zoom, or Microsoft Teams URL"),
  hermes: z.object({
    base_url: url,
    api_key: secret,
    model: z.string().min(1).default("hermes-agent"),
    mode: z.enum(["auto", "responses", "chat_completions"]).default("auto"),
    instructions: z.string().default(
      "You are participating in a live meeting. Answer concisely and naturally. " +
      "Use your tools and memory when useful, but return only the answer intended for participants."
    ),
    timeout_seconds: z.number().positive().max(600).default(90)
  }),
  meetstream: z.object({
    base_url: url.default("https://api.meetstream.ai"),
    api_key: secret,
    mia: z.object({
      agent_config_id: z.string().min(1).optional(),
      create: miaCreate.optional(),
      reuse_by_name: z.boolean().default(true)
    }).default({ reuse_by_name: true }),
    bot_name: z.string().min(1).default("Hermes Meeting Agent"),
    bot_message: z.string().optional().default(
      "Hermes has joined the meeting. Start with Hey Hermes, Hey Assistant, Hey Bot, Okay Agent, or Okay Bot."
    ),
    video_required: z.boolean().default(false),
    automatic_leave: object.default({
      waiting_room_timeout: 600,
      everyone_left_timeout: 120,
      voice_inactivity_timeout: 600,
      in_call_recording_timeout: 14400,
      recording_permission_denied_timeout: 60
    })
  }),
  // An empty list intentionally opts out of wake-word gating for advanced use cases.
  wake_words: z.array(z.string().trim().min(1)).default([...defaultWakeWords]),
  output: z.enum(["chat", "voice", "hybrid"]).default("chat"),
  speech: z.object({
    base_url: url,
    api_key: secret,
    model: z.string().default("tts-1"),
    voice: z.string().default("alloy"),
    sample_rate: z.number().int().min(8000).max(48000).default(24000),
    timeout_seconds: z.number().positive().max(300).default(60)
  }).optional()
}).superRefine((value, context) => {
  if (value.output !== "chat" && !value.speech) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["speech"],
      message: "speech configuration is required for voice or hybrid output"
    });
  }
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export function platformFor(url: string): "google_meet" | "zoom" | "microsoft_teams" {
  const host = new URL(url).hostname;
  if (host.includes("zoom")) return "zoom";
  if (host.includes("teams.microsoft")) return "microsoft_teams";
  return "google_meet";
}
