# Webhook lifecycle and verification

Verified 2026-09-11 against the live guides.

Normalize the event name as `payload.bot_event || payload.event`; current
lifecycle docs say to branch on bot_event and examples may include both.
Keep bot_id, bot_status, message, status_code, timestamp and custom_attributes.

| Event | Meaning |
| --- | --- |
| bot.scheduled | Future dispatch accepted |
| bot.joining → bot.in_waiting_room → bot.inmeeting | Dispatch, admission wait, joined |
| bot.recording_permission_allowed / denied | Zoom recording consent |
| bot.recording | Capture started |
| bot.leaving | Exiting |
| bot.stopped | Clean participation end |
| bot.kicked | Removed; bot_status is still Stopped |
| bot.notallowed / bot.denied / bot.failed | Admission timeout, refusal, runtime failure |
| audio.processed / transcription.processed / video.processed | Individual artifact readiness |
| bot.done | Post-call processing completed |
| data_deletion | Stored media expired/deleted; MediaExpired |

Terminal participation events are distinct; don't collapse all failures into
bot.stopped. MediaProcessing is a status without its own webhook. Zoom
recording denial ends with bot.stopped, not bot.denied. Delivery is best-effort:
non-2xx responses are not retried. Persist promptly and reconcile via API reads;
handle repeated joining events idempotently.
Source: [events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events).

Streaming and native-caption providers do not follow the normal
transcription.processed/bot.done completion path. Non-terminal bot.error can
signal a streaming provider error. Fetch captions from detail.caption_file
(the response commonly nests this under bot_details); persist streaming text
at its live webhook. Do not wait forever for absent events.
Source: [debugging](https://docs.meetstream.ai/guides/help/debugging-bots).

Create workspace webhook endpoints in Dashboard → Webhooks, select event
subscriptions, and inspect delivery logs. Workspace events can be routed by
custom_attributes; per-bot callback_url is a separate delivery option.
Source: [workspace endpoints](https://docs.meetstream.ai/guides/webhooks/workspace-webhooks).

Workspace endpoints sign the raw request bytes using HMAC-SHA256 and the
endpoint secret: compare the hex digest with the sha256= suffix in
X-MeetStream-Signature using constant-time comparison. Header lookup must be
case-insensitive. Validate X-MeetStream-Timestamp as ISO8601, reject malformed
values, and apply a replay window plus duplicate detection. HMAC covers raw
body only; do not prepend the timestamp or reserialize JSON. Secrets are
shown once and regenerating invalidates the old secret. Per-bot callback_url
deliveries are unsigned; do not claim the same verification contract there.
Source: [signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification).

For local development, run a receiver and expose it through an HTTPS tunnel
such as ngrok or Cloudflare. Test reachable paths and subscribed events;
localhost itself is unreachable to MeetStream. Return 2xx after durable
acceptance and process slow work asynchronously. A tunnel URL can change,
requiring an endpoint update. Keep meeting data out of public logs.
Source: [local server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server).
