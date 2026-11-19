import { z } from 'zod';

/**
 * Deliberately permissive: MeetStream adds event types over time and an unknown
 * event must not crash the handler. We validate the fields we route on and keep
 * the rest.
 */
export const webhookEventSchema = z
  .object({
    event: z.string().optional(),
    bot_event: z.string().optional(),
    bot_id: z.string().optional(),
    bot_status: z.string().optional(),
    message: z.string().optional(),
    status_code: z.number().optional(),
    timestamp: z.string().optional(),
    custom_attributes: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** Terminal `bot.stopped` deliveries whose `bot_event` means the meeting never recorded. */
const FAILED_BOT_EVENTS = new Set(['bot.notallowed', 'bot.denied', 'bot.failed']);

export function isJoinFailure(event: WebhookEvent): boolean {
  return event.event === 'bot.stopped' && FAILED_BOT_EVENTS.has(event.bot_event ?? '');
}
