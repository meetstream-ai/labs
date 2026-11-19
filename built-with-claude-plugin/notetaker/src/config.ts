import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Read .env into process.env. Called from the CLI entrypoint only — importing a
 * module must not have the side effect of pulling a developer's real secrets
 * into a test run.
 */
export function loadEnvFile(): void {
  loadDotenv({ quiet: true });
}

/**
 * Everything the app reads from the environment. Parsed once, at startup, so a
 * missing key fails immediately instead of halfway through a meeting.
 */
const schema = z.object({
  MEETSTREAM_API_KEY: z.string().min(1),
  MEETSTREAM_BASE_URL: z.string().url().default('https://api.meetstream.ai/api/v1'),

  /** Public HTTPS origin of the webhook server, e.g. an ngrok URL. No trailing slash. */
  PUBLIC_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Random secret embedded in the webhook path. Per-bot `callback_url` deliveries
   * are unsigned, so the unguessable path is what keeps the route from being an
   * open endpoint. See docs/webhook-security.md.
   */
  WEBHOOK_PATH_TOKEN: z.string().min(16),

  /**
   * HMAC secret for workspace-level webhook endpoints. Optional: per-bot callbacks
   * are not signed, so leave it unset unless you have configured a workspace endpoint.
   */
  WEBHOOK_SIGNING_SECRET: z.string().min(1).optional(),
  WEBHOOK_SIGNATURE_HEADER: z.string().min(1).default('x-meetstream-signature'),
  WEBHOOK_TIMESTAMP_HEADER: z.string().min(1).default('x-meetstream-timestamp'),
  /** Reject signed deliveries whose timestamp is older than this, to blunt replays. */
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  LLM_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  LLM_MODEL: z.string().min(1).default('claude-sonnet-5'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /**
   * `meetstream` is the in-house post-call engine and needs no external provider
   * key, so it is the only safe default. `deepgram` and `assemblyai` require that
   * key on your MeetStream account, and without it the bot ends in
   * `transcription.failed` after the meeting is already over.
   */
  TRANSCRIPT_PROVIDER: z.enum(['deepgram', 'assemblyai', 'meetstream']).default('meetstream'),
  TRANSCRIPT_LANGUAGE: z.string().min(1).default('en'),

  BOT_NAME: z.string().min(1).default('Notetaker'),
  /** Where the markdown briefs land. */
  BRIEF_DIR: z.string().min(1).default('./briefs'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A key left blank in .env (`WEBHOOK_SIGNING_SECRET=`) arrives as "", which
  // means "not set" here, so a copied .env.example parses.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. Check your .env against .env.example:\n${issues}`);
  }

  const config = parsed.data;
  if (config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.');
  }
  return config;
}

/** Full public URL MeetStream should call back, including the secret path segment. */
export function webhookUrl(config: Config): string {
  return `${config.PUBLIC_URL}${webhookPath(config)}`;
}

export function webhookPath(config: Config): string {
  return `/webhook/meetstream/${config.WEBHOOK_PATH_TOKEN}`;
}
