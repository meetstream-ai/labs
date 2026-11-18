import { loadConfig, loadEnvFile, webhookUrl, type Config } from './config.js';
import { createLlmProvider } from './llm/index.js';
import { logger, setLogLevel } from './logger.js';
import { MeetStreamClient } from './meetstream/client.js';
import { handleEvent } from './pipeline.js';
import { createServer } from './webhook/server.js';

const USAGE = `notetaker — AI meeting briefs on MeetStream

Usage:
  notetaker join <meeting-url>   Send a bot to a meeting and print its bot id
  notetaker serve                Run the webhook server that writes briefs
  notetaker brief <bot-id>       Re-run the brief for a finished meeting

The bot posts its events to the URL in PUBLIC_URL, so 'serve' must be running
and publicly reachable over HTTPS before you 'join'.
`;

function build(config: Config) {
  const client = new MeetStreamClient({
    apiKey: config.MEETSTREAM_API_KEY,
    baseUrl: config.MEETSTREAM_BASE_URL,
  });
  return { client, llm: createLlmProvider(config), briefDir: config.BRIEF_DIR };
}

async function join(config: Config, meetingLink: string): Promise<void> {
  const { client } = build(config);
  const callbackUrl = webhookUrl(config);

  const botId = await client.createBot({
    meetingLink,
    callbackUrl,
    botName: config.BOT_NAME,
    transcriptProvider: config.TRANSCRIPT_PROVIDER,
    language: config.TRANSCRIPT_LANGUAGE,
  });

  logger.info('Bot dispatched', { botId, meetingLink });
  process.stdout.write(
    `\nBot ${botId} is joining.\nEvents go to ${callbackUrl}\nThe brief lands in ${config.BRIEF_DIR} once the transcript is ready.\n`,
  );
}

async function serve(config: Config): Promise<void> {
  const app = createServer({ config, ...build(config) });
  app.listen(config.PORT, () => {
    logger.info('Webhook server listening', { port: config.PORT, url: webhookUrl(config) });
  });
}

async function brief(config: Config, botId: string): Promise<void> {
  const result = await handleEvent(
    { event: 'transcription.processed', bot_id: botId },
    build(config),
  );
  if (result.status !== 'written') {
    throw new Error(`Could not build a brief for ${botId}: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`\nWrote ${result.path}\n`);
}

async function main(argv: string[]): Promise<void> {
  const [command, argument] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  loadEnvFile();
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  switch (command) {
    case 'join':
      if (!argument) throw new Error('join needs a meeting URL');
      await join(config, argument);
      return;
    case 'serve':
      await serve(config);
      return;
    case 'brief':
      if (!argument) throw new Error('brief needs a bot id');
      await brief(config, argument);
      return;
    default:
      process.stdout.write(USAGE);
      throw new Error(`Unknown command: ${command}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
