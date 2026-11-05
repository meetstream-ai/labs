# Create Your First Meeting Bot with the MeetStream API

Send a MeetStream API bot into a Zoom, Google Meet or Microsoft Teams meeting, poll its status until the session ends, and print the result. This is the "hello world" of the MeetStream API: one `create_bot` call, one status loop, no webhooks or transcription yet.

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

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/quickstart-first-bot
npm install
cp .env.example .env   # set MEETSTREAM_API_KEY and MEETING_LINK
node index.js
```

Start the meeting first so there is something for the bot to join, then admit it from the waiting room.

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

## Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | From https://app.meetstream.ai, sent as `Authorization: Token <key>` |
| `MEETING_LINK` | yes | | Full Zoom / Meet / Teams URL |
| `BOT_NAME` | no | `Quickstart Bot` | Display name inside the meeting |
| `VIDEO_REQUIRED` | no | `false` | Video is off by default; `true` records video as well as audio |
| `VIDEO_LAYOUT` | no | `speaker_view` | Only read when `VIDEO_REQUIRED=true`. `speaker_view` or `grid_view`. The API default is `grid_view`, so speaker view is always sent explicitly |
| `MEETSTREAM_API_BASE_URL` | no | `https://api.meetstream.ai/api/v1` | Override for testing |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required config: MEETSTREAM_API_KEY, MEETING_LINK` | `.env` never created or values blank | `cp .env.example .env` and fill both in. |
| `API error 401` | No key was sent | Set `MEETSTREAM_API_KEY`. |
| `API error 403` | Key rejected | Copy it again in full, with no trailing whitespace. |
| `API error 400` | Validation failed; the response `message` names the field | Usually a malformed `meeting_link`. |
| `API error 429` | Rate limited | Wait and retry. |
| `API error 507` | Idempotent replay | This is success; the original bot is returned. |
| Stuck on `InWaitingRoom`, then `NotAllowed` | Nobody admitted the bot before the waiting-room timeout | Admit it from the People panel, or raise `automatic_leave.waiting_room_timeout` (up to 600 seconds on Google Meet). |
| Status never changes from `Joining` | The meeting has not started, or requires registration | Start the meeting, or use a link that allows guests. |
| Loop ends with `Error` | The session failed | Check `GET /bots/{id}/detail` for the reason. |

## Related

- [Create your first bot](https://docs.meetstream.ai/guides/get-started/create-your-first-bot)
- [How bots work](https://docs.meetstream.ai/guides/introduction/how-bots-work)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- [Get bot status](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/get-bot-status)
- [Authentication](https://docs.meetstream.ai/api-reference/authentication)
- [Error codes](https://docs.meetstream.ai/errors)
- Labs: [bot-status-monitor](../bot-status-monitor) renders the full lifecycle as a live timeline; [list-and-manage-bots](../list-and-manage-bots) lists every bot and makes an active one leave; [post-call-transcription](../post-call-transcription) gets the transcript once the call ends
