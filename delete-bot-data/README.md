# delete-bot-data

Permanently erase a bot's recordings and transcripts with `DELETE /bots/{id}/delete`, behind an explicit confirmation prompt, and watch the `data_deletion` webhook that fires as a result.

**This template destroys data. There is no undo, no trash, and no restore.**

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY
node index.js inspect <bot_id>   # start here: see what exists, delete nothing
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A bot id whose data you genuinely want gone
- For the webhook half: a way to expose a local port publicly (ngrok, Cloudflare Tunnel, or a deployed host)

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

It is irreversible. If you only want the bot out of a live meeting, that is a completely different call: `GET /bots/{id}/remove_bot`, which keeps every recording. See the `list-and-manage-bots` template.

## The confirmation prompt

`delete` runs `inspect` first so you can see what you are about to destroy, then asks you to type the full bot id. Not `y`, not `yes`, the whole id. Deletion cannot be undone, so a slip of the finger should not be enough to trigger it.

If stdin is not a TTY (a pipe, a CI job) the prompt cannot run and the command refuses rather than silently deleting. `--force` overrides that, and exists precisely so that the dangerous path in a script is explicit and greppable.

## The data_deletion webhook

Deletion fires a `data_deletion` event to the bot's `callback_url`:

```json
{
  "event": "data_deletion",
  "bot_id": "bot_abc123",
  "bot_status": "...",
  "message": "...",
  "status_code": 200,
  "custom_attributes": {}
}
```

`data_deletion` is the last event in the bot lifecycle. After it, `GET /bots/{id}/detail` and every media endpoint return 404 for that bot.

To see it live:

1. `node index.js listen` in one terminal
2. Expose the port: `ngrok http 3000`, giving you something like `https://abc123.ngrok-free.app`
3. Create a bot with `callback_url` set to `https://abc123.ngrok-free.app/webhook`
4. Let the session finish
5. `node index.js delete <that bot id>` in a second terminal

**The callback_url has to be set when the bot is created.** There is no global webhook endpoint and no way to attach a URL to an existing bot, so you cannot point this listener at a bot that was created without one.

The envelope key is `event`, not `bot_event`. Anything that tells you otherwise is out of date.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | Not needed for `listen` |
| `BOT_ID` | no | | Default target for `inspect` and `delete` |
| `PORT` | no | `3000` | Port for the webhook listener |
| `MEETSTREAM_API_BASE_URL` | no | production | Override for testing |

## Troubleshooting

**`API error 404` on delete** - the bot id is wrong, or the data was already deleted. Deleting twice is not an error you can recover information from, the first one already won.

**No `data_deletion` event arrives** - the bot was created without a `callback_url`, or the URL points somewhere other than this listener. Check your tunnel is up and the path ends in `/webhook`.

**Events arrive but the listener shows `(missing 'event' key)`** - something other than MeetStream is posting to the endpoint. The real payload always has `event`.

**Data disappeared without anyone calling delete** - check the retention window. `recording_config.retention` expires artifacts automatically, and the API default is 24 hours. See the `bot-retention-config` template.
