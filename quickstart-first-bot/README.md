# quickstart-first-bot

Send a MeetStream bot into a meeting, poll its status until the session ends, and print the result. This is the "hello world" of the MeetStream API.

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js
```

## Prerequisites

- Node.js 18 or newer (the code uses the built-in `fetch`)
- A MeetStream API key from https://app.meetstream.ai
- A live meeting link (Zoom, Google Meet, or Microsoft Teams)

## Setup

1. `npm install`
2. Copy `.env.example` to `.env`
3. Set `MEETSTREAM_API_KEY` and `MEETING_LINK`
4. Start the meeting so there is something for the bot to join
5. `node index.js`

## What it does

**Step 1. Create the bot**

```http
POST https://api.meetstream.ai/api/v1/bots/create_bot
Authorization: Token <your key>
Content-Type: application/json

{
  "meeting_link": "https://meet.google.com/xxx-xxxx-xxx",
  "bot_name": "Quickstart Bot",
  "video_required": false
}
```

The response is `{ bot_id, transcript_id, meeting_url, status }`. `transcript_id` is `null` here because this template does not configure a transcription provider. See the `post-call-transcription` template for that.

Two things developers get wrong on the first call:

- the auth scheme is literally `Token`, not `Bearer`
- the field is `meeting_link`, not `meeting_url`

**Step 2. Poll the status**

```http
GET /bots/{bot_id}/status
```

The loop runs every 5 seconds and prints only when the value changes, so the output reads as a lifecycle log rather than a wall of repeats. It gives up after 240 polls (20 minutes) so a forgotten run cannot spin forever.

**Step 3. Stop at a terminal status**

| bot_status | Terminal | Meaning |
|---|---|---|
| `Joining` | no | Dialling into the meeting |
| `InWaitingRoom` | no | Waiting to be admitted |
| `InMeeting` | no | Admitted and present |
| `Recording` | no | Capturing audio (and video if enabled) |
| `Leaving` | no | Shutting the session down |
| `Stopped` | yes | Left the meeting normally |
| `Done` | yes | Session finished and post-processing completed |
| `NotAllowed` | yes | Waiting-room timeout, nobody let the bot in |
| `Denied` | yes | The host denied the bot |
| `Error` | yes | The session failed |

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | From https://app.meetstream.ai |
| `MEETING_LINK` | yes | | Full Zoom / Meet / Teams URL |
| `BOT_NAME` | no | `Quickstart Bot` | Display name inside the meeting |
| `VIDEO_REQUIRED` | no | `false` | `true` records video as well as audio |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

## Troubleshooting

**`API error 401`** - no key was sent. `MEETSTREAM_API_KEY` is empty or `.env` was never created.

**`API error 403`** - the key was rejected. Copy it again in full, with no trailing whitespace.

**`API error 400`** - validation failed. The response `message` says which field. Usually a malformed `meeting_link`.

**Stuck on `InWaitingRoom` then `NotAllowed`** - the bot was never admitted. Admit it manually, or use an `automatic_leave.waiting_room_timeout` longer than the default.

**Status never changes from `Joining`** - the meeting has not started, or the link points at a meeting that requires registration.

## Next

- `bot-status-monitor` renders the full lifecycle as a live timeline
- `list-and-manage-bots` lists every bot and makes an active one leave
- `post-call-transcription` gets the transcript once the call ends
