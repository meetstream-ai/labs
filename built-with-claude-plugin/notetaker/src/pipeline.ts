import { generateBrief } from './brief/generate.js';
import { writeBrief } from './brief/render.js';
import type { LlmProvider } from './llm/types.js';
import { logger } from './logger.js';
import type { MeetStreamClient } from './meetstream/client.js';
import { isJoinFailure, type WebhookEvent } from './webhook/events.js';

export interface PipelineOptions {
  client: MeetStreamClient;
  llm: LlmProvider;
  briefDir: string;
}

export type PipelineResult =
  | { status: 'written'; path: string; botId: string }
  | { status: 'ignored'; reason: string }
  | { status: 'failed'; reason: string; botId: string };

/**
 * Turns one webhook event into a brief on disk. Pure enough to test directly:
 * every dependency arrives through options.
 */
export async function handleEvent(
  event: WebhookEvent,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const botId = event.bot_id;

  if (event.event === 'transcription.failed') {
    // Nearly always a provider key the account does not have: the audio is still
    // stored, so switching TRANSCRIPT_PROVIDER and re-running is the way back.
    logger.error('Transcription failed', { botId, detail: event.message });
    return { status: 'failed', reason: event.message ?? 'transcription.failed', botId: botId ?? '' };
  }

  if (isJoinFailure(event)) {
    logger.error('Bot never recorded the meeting', {
      botId,
      botEvent: event.bot_event,
      detail: event.message,
    });
    return {
      status: 'failed',
      reason: event.bot_event ?? 'bot.stopped',
      botId: botId ?? '',
    };
  }

  if (event.event !== 'transcription.processed') {
    return { status: 'ignored', reason: event.event ?? 'unknown' };
  }
  if (!botId) {
    return { status: 'ignored', reason: 'transcription.processed without bot_id' };
  }

  logger.info('Building brief', { botId });
  const [segments, details] = await Promise.all([
    options.client.getTranscript(botId),
    options.client.getBotDetails(botId),
  ]);

  const body = await generateBrief({
    segments,
    llm: options.llm,
    meetingLink: details.MeetingLink,
  });
  const { path } = await writeBrief(options.briefDir, {
    botId,
    body,
    meetingLink: details.MeetingLink,
  });

  logger.info('Brief written', { botId, path });
  return { status: 'written', path, botId };
}
