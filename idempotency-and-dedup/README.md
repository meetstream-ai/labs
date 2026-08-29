# idempotency-and-dedup

Two different mechanisms stop `create_bot` from producing duplicate bots. This template runs both against the live API so you can see the actual status codes: the `Idempotency-Key` header (replay returns **507**, which is a success) and the `deduplication_key` body field (replay returns **200**, reuse for a different meeting returns **409**).

```bash
npm install
cp .env.example .env   # then fill in MEETSTREAM_API_KEY and MEETING_LINK
node index.js --explain   # comparison table, no API key needed
node index.js             # run the live demo
```

## Prerequisites

- Node.js 18 or newer
- A MeetStream API key from https://app.meetstream.ai
- A meeting link, and optionally a second, different one (`MEETING_LINK_ALT`) to see the 409

## Usage

```bash
node index.js --explain      # the comparison table, no API calls
node index.js                # create real bots and exercise both mechanisms
node index.js --no-cleanup   # leave the created bots in their meetings
```

The demo creates real bots. When it finishes it calls `GET /bots/{id}/remove_bot` on each one so they leave the meeting. Recorded data is never deleted.

## The two mechanisms

| | `Idempotency-Key` | `deduplication_key` |
|---|---|---|
| Where | HTTP header | `create_bot` body field |
| Scope | One retried request | One logical booking |
| You generate | A fresh UUID per call site | A stable id from your own data |
| Replay result | **507**, original bot returned | **200**, original bot returned |
| Same key, different meeting | n/a | **409** conflict |
| Solves | "My POST timed out, is it safe to retry?" | "Two workers grabbed the same calendar event" |

They compose. A scheduler can send a stable `deduplication_key` for the booking and a fresh `Idempotency-Key` for each transport-level attempt.

## Part 1: Idempotency-Key

```http
POST /bots/create_bot
Authorization: Token <your key>
Idempotency-Key: 3f2b0c74-1f0a-4e2e-9a1f-0f9d1f7c2b41
Content-Type: application/json

{ "meeting_link": "...", "bot_name": "Idempotency Demo Bot", "video_required": false }
```

Send it once: `201`, a bot is created. Send the identical request again with the same key: `507`, and the response carries the original bot. One bot exists, and you were charged once.

**507 is the single most misread code in this API.** It sits in the 5xx range, so:

- a "retry on 5xx" wrapper will loop on it forever
- a `if (!res.ok) throw` wrapper will report a successful booking as a failure

Treat 507 as success. `src/api.js` in this template does exactly that via the `accept` list, and `verdict()` in `src/demo.js` spells it out.

Generate the key at the call site, once, and reuse it across retries of that one call. A key generated inside the retry loop defeats the whole thing.

## Part 2: deduplication_key

```http
POST /bots/create_bot

{
  "meeting_link": "...",
  "bot_name": "Dedup Demo Bot",
  "video_required": false,
  "deduplication_key": "calendar-event-9f3a11"
}
```

- Same key, same `meeting_link`: `200`, the existing bot comes back. Nothing new was created.
- Same key, a **different** `meeting_link`: `409`. The key is already bound to another booking.

Do not retry a 409. It is not transient, and retrying will never make it succeed. Either the key was reused by mistake or two bookings genuinely collided, and both need a code fix rather than a backoff.

Pick a key that identifies the booking, not the attempt: a calendar event id, a database row id, a CRM meeting id. Anything derived from the clock or a random value defeats the purpose.

## Status codes this template treats as success

| Code | Meaning | Retry? |
|---|---|---|
| 200 | Existing resource returned (dedup replay) | no, it worked |
| 201 | Created | no |
| 202 | Still processing | yes, poll |
| 409 | Dedup conflict | **no**, fix the key |
| 429 | Rate limited | yes, with backoff |
| 500 / 503 | Transient server error | yes, with backoff |
| **507** | **Idempotent replay, success** | **no, it worked** |

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MEETSTREAM_API_KEY` | yes | | Not needed for `--explain` |
| `MEETING_LINK` | yes | | The meeting the demo bots join |
| `MEETING_LINK_ALT` | no | | A **different** meeting link. Without it the 409 case is skipped |
| `MEETSTREAM_API_BASE_URL` | no | production | Override for testing |

## Troubleshooting

**The retry returned 201 instead of 507** - the second request did not carry the same `Idempotency-Key`, or the body differed. Both have to match.

**The 409 case was skipped** - `MEETING_LINK_ALT` is not set, or it is the same URL as `MEETING_LINK`. It has to be a genuinely different meeting.

**Everything returns 409 on a second run** - `deduplication_key` values persist. The demo timestamps its key for this reason, so each run gets a fresh one.

**Bots piled up in the meeting** - you used `--no-cleanup`, or cleanup failed. Use the `list-and-manage-bots` template to find and remove them.
