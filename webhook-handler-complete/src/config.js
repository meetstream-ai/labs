import 'dotenv/config';

const STREAMING_PROVIDERS = new Set([
  'deepgram_streaming',
  'assemblyai_streaming',
  'jigsawstack_streaming',
  'meetstream_streaming',
  'meeting_captions',
]);

const POST_CALL_PROVIDERS = new Set([
  'deepgram',
  'assemblyai',
  'sarvam',
  'jigsawstack',
  'meetstream',
]);

export function loadConfig({ requireApiKey = false } = {}) {
  const apiKey = process.env.MEETSTREAM_API_KEY;
  if (requireApiKey && !apiKey) {
    console.error(
      'Missing MEETSTREAM_API_KEY. Copy .env.example to .env and set your key from https://app.meetstream.ai',
    );
    process.exit(1);
  }

  const provider = process.env.TRANSCRIPT_PROVIDER || 'deepgram';
  if (!STREAMING_PROVIDERS.has(provider) && !POST_CALL_PROVIDERS.has(provider)) {
    console.error(
      `Unknown TRANSCRIPT_PROVIDER "${provider}". Post-call: ${[...POST_CALL_PROVIDERS].join(', ')}. Streaming: ${[...STREAMING_PROVIDERS].join(', ')}.`,
    );
    process.exit(1);
  }

  return {
    apiKey,
    baseUrl: process.env.MEETSTREAM_BASE_URL || 'https://api.meetstream.ai/api/v1',
    port: Number(process.env.PORT || 3000),
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    meetingLink: process.env.MEETING_LINK || '',
    botName: process.env.BOT_NAME || 'Webhook Reference Bot',
    videoRequired: process.env.VIDEO_REQUIRED === 'true',
    provider,
    streamingOnly: STREAMING_PROVIDERS.has(provider),
  };
}

export { STREAMING_PROVIDERS, POST_CALL_PROVIDERS };
