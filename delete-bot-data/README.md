# Delete Meeting Bot Recordings and Transcripts with the MeetStream API

Permanently erase a MeetStream meeting bot's recordings, transcripts and screenshots (Zoom, Google Meet or Microsoft Teams) with `DELETE /bots/{id}/delete`, behind an explicit confirmation prompt, and watch the `data_deletion` webhook that fires as a result. Useful for GDPR erasure requests and retention clean-up.

**This template destroys data. There is no undo, no trash, and no restore.**

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js inspect <bot_id>   # start here: see what exists, delete nothing
```

## How it works

- `inspect <bot_id>` reads `GET /bots/{id}/detail` and prints what exists for the bot. Nothing is deleted.
- `delete <bot_id>` runs `inspect`, asks you to type the full bot id, then calls `DELETE /bots/{id}/delete`. `--force` skips the prompt for scripts.
- `listen` starts a small Express server (`POST /webhook`, `GET /health`) that prints every MeetStream event and highlights `data_deletion`.
- Every request sends `Authorization: Token <key>`; API error bodies (`{ "message": "..." }`) are surfaced as-is, and 4xx responses are never retried.

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A bot id whose data you genuinely want gone
- For the webhook half: a way to expose a local port publicly (ngrok, Cloudflare Tunnel, or a deployed host)

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/delete-bot-data
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js --help
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes (not for `listen`) | API key, sent as `Authorization: Token <key>` |
| `BOT_ID` | no | Default target for `inspect` and `delete`; a positional argument overrides it |
| `PORT` | no | Port for the webhook listener (default `3000`) |
| `MEETSTREAM_API_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |

## Usage

```bash
node index.js listen                    # webhook listener on PORT (default 3000)
node index.js inspect bot_abc123        # show what would be erased, erase nothing
node index.js delete  bot_abc123        # erase it, after typing the id to confirm
node index.js delete  bot_abc123 --force  # skip the prompt, for scripts
```

## What gets erased

`DELETE /bots/{bot_id}/delete` removes the bot's stored artifacts:

- the audio recording
- the video recording and any per-participant streams
- screenshots
- the transcript

It is irreversible. If you only want the bot out of a live meeting, that is a completely different call: `GET /bots/{id}/remove_bot`, which keeps every recording. See [../list-and-manage-bots](../list-and-manage-bots).

## The confirmation prompt

`delete` runs `inspect` first so you can see what you are about to destroy, then asks you to type the full bot id. Not `y`, not `yes`, the whole id. Deletion cannot be undone, so a slip of the finger should not be enough to trigger it.

If stdin is not a TTY (a pipe, a CI job) the prompt cannot run and the command refuses rather than silently deleting. `--force` overrides that, and exists precisely so that the dangerous path in a script is explicit and greppable.

## The data_deletion webhook

Deletion fires a `data_deletion` event to the bot's `callback_url`:

```json
{
  "event": "data_deletion",
  "bot_event": "data_deletion",
  "bot_id": "bot_abc123",
  "bot_status": "...",
  "message": "...",
  "status_code": 200,
  "timestamp": "2026-01-15T10:30:45Z"
}
```

Unlike most events, `data_deletion` carries no `custom_attributes`, so do not rely on them to route it.

`data_deletion` fires only after a delete or a retention expiry, so it comes after `bot.done` and is the last event you will see for that bot. After it, `GET /bots/{id}/detail` and every media endpoint return 404 for that bot.

To see it live:

1. `node index.js listen` in one terminal
2. Expose the port: `ngrok http 3000`, giving you something like `https://abc123.ngrok-free.app`
3. Create a bot with `callback_url` set to `https://abc123.ngrok-free.app/webhook`
4. Let the session finish
5. `node index.js delete <that bot id>` in a second terminal

**The callback_url has to be set when the bot is created.** There is no way to attach a URL to an existing bot, so you cannot point this listener at a bot that was created without one. Webhook deliveries are not retried, so keep the listener up while you delete.

Every delivery carries `event`. Most also carry `bot_event` with the specific name (equal to `event` except on terminals, where `event` is `bot.stopped` and `bot_event` is the reason, such as `bot.kicked`), so read `bot_event ?? event`. The listener prints both when they differ.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MEETSTREAM_API_KEY is not set` | `.env` missing or empty | `cp .env.example .env` and add your key |
| 401 / 403 | 401 = no key sent, 403 = key rejected | Check the key for stray quotes or whitespace |
| `API error 404` on `inspect` or `delete` | Wrong bot id, or the data was already deleted | Check the id with `GET /bots`; a second delete has nothing left to remove |
| `delete` refuses to run | stdin is not a TTY (pipe, CI), so the confirmation prompt cannot run | Run it interactively, or pass `--force` deliberately |
| No `data_deletion` event arrives | Bot was created without a `callback_url`, or the URL points elsewhere; deliveries are not retried | Check the tunnel is up and the path ends in `/webhook`; create a new bot with the right URL |
| Listener shows `(missing 'event' key)` | Something other than MeetStream is posting to the endpoint | The real payload always has `event` |
| Data disappeared without anyone calling delete | Retention expired: `recording_config.retention` defaults to 30 days (720 hours) when no retention block is sent | See [../bot-retention-config](../bot-retention-config) |

## Related

- [Delete bot data](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/delete-bot-data)
- [Get bot details](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-details)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- Related templates: [../bot-retention-config](../bot-retention-config), [../list-and-manage-bots](../list-and-manage-bots), [../webhook-local-tunnel](../webhook-local-tunnel)
