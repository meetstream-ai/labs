# bot-lifecycle-state-machine

Models the MeetStream bot lifecycle as an explicit, webhook-driven state machine: persists state to a JSON file, refuses to walk backwards on out-of-order deliveries, and flags bots that are stuck or abandoned.

```bash
npm install && node index.js
```

See all of it, offline, in about 20 seconds:

```bash
node index.js --replay
```

---

## What this does

- Drives a state machine from webhook deliveries, with a rank per state so a late or duplicated event can never regress the record
- Handles both provider paths: post-call and streaming-only bots both end at `bot.done`; streaming-only bots just never get `transcription.processed`
- Decodes all five `bot.stopped` reasons from `bot_event` (clean exit, kick, lobby timeout, denial, failure) into distinct states and outcomes
- Persists every bot to `data/bots.json` with atomic writes, so state survives a restart
- Scans on a timer for **stuck** bots (too long in one state) and **abandoned** bots (gone silent and not coming back)
- Prints a ledger of every bot with its path, state, health, and outcome

Sample ledger:

```
  bot_id                      path       state                 health     outcome    stop            events
  ----------------------------------------------------------------------------------------------------
  lc-ghost-no-webhooks        post-call  created               abandoned  in-flight  -               0
  lc-stalled-in-processing    post-call  processing            stuck      in-flight  -               0
  lc-postcall                 post-call  deleted               ok         deleted    bot.stopped     12
  lc-streaming                streaming  done                  ok         success    bot.stopped     9
  lc-kicked                   post-call  done                  ok         success    bot.kicked      9
  lc-notallowed               post-call  never_admitted        ok         failure    bot.notallowed  5
  lc-denied                   post-call  never_admitted        ok         failure    bot.denied      5
  lc-failed                   post-call  done_failed           ok         failure    bot.failed      8
  lc-outoforder               post-call  done                  ok         success    bot.stopped     8
```

## Prerequisites

- Node.js 18 or newer
- A public HTTPS URL to receive real webhooks. See the `webhook-local-tunnel` template. `--replay` needs nothing.

## Setup and run

```bash
cp .env.example .env
npm install

node index.js            # receiver + monitor
node index.js --replay   # replay every lifecycle path offline, then report
node index.js --report   # print the persisted state file and exit
```

Inspect while it runs:

```bash
curl localhost:3000/bots           # the ledger
curl localhost:3000/bots/<bot_id>  # full record + health + outcome
curl localhost:3000/states         # the state table
```

---

## Why a state machine

A handler that does `state = eventName` breaks on the first real-world delivery quirk. Four specific things force the extra structure:

**Delivery is at-least-once and not order-guaranteed.** A delayed `bot.joining` can land after `bot.recording`. Every state carries a `rank`, and the machine only moves forward:

```
bot.recording   created -> recording
bot.joining     [recording] out-of-order bot.joining: "joining" ranks below current "recording", ignored
bot.inmeeting   [recording] out-of-order bot.inmeeting: "in_meeting" ranks below current "recording", ignored
```

**`bot.done` is the one final event, on every path.** Post-call bots, streaming-only bots, and bots that never got in all end with it. `audio.processed` is never final. What the provider changes is only whether `transcription.processed` shows up on the way.

**Every ending arrives as `bot.stopped`, with the reason in `bot_event`.** Five reasons, two of which mean no media will ever exist. `bot_status` cannot tell a kick from a clean exit (both say `Stopped`) and its failure casing varies, so it is only a case-insensitive fallback when `bot_event` is missing.

**`bot.error` is not terminal.** It maps to `null`, so the machine records the error and does not move.

## The state table

```
created            no webhooks yet
  |
joining -> waiting_room -> in_meeting -> recording -> leaving
  |
bot.stopped forks on bot_event (none of these is terminal, bot.done follows):
  bot.stopped     -> stopped         (continue to processing)
  bot.kicked      -> kicked          (continue to processing)
  bot.failed      -> stopped_error   (continue, assets may be partial)
  bot.notallowed  -> not_allowed     (no media, bot.done next)
  bot.denied      -> denied          (no media, bot.done next)
  |
processing -> media_ready -> transcribed   (streaming-only skips transcribed)
  |
bot.done, final on every path:
  after notallowed / denied           -> never_admitted   TERMINAL, failure
  after bot.failed or a failed
    transcription                     -> done_failed      TERMINAL, failure
  otherwise                           -> done             TERMINAL, success
  |
data_deletion -> deleted   TERMINAL (the one state allowed to follow another terminal)
```

Events that record information without moving state: `bot.error`, `transcription.failed`, `video.processed`.

### The two paths

| | post-call providers | streaming-only providers |
| --- | --- | --- |
| Providers | `deepgram`, `assemblyai`, `sarvam`, `jigsawstack`, `meetstream` | `deepgram_streaming`, `assemblyai_streaming`, `jigsawstack_streaming`, `meetstream_streaming`, `meeting_captions` |
| Terminal event | `bot.done` | `bot.done` |
| `transcription.processed` / `.failed` | yes | never |
| Post-call transcript | yes | no, `get_transcript` returns 202 forever, so do not fetch one |

**The webhook payload does not tell you which one you are on.** The fix is to stamp it at `create_bot` time and read it back:

```js
custom_attributes: { streaming_only: 'true' }   // values must be STRINGS
```

`DEFAULT_STREAMING_ONLY` in `.env` is only a fallback for bots that were not stamped.

### `status_code` on `bot.stopped`

| `bot_event` | `status_code` | `bot_status` |
| --- | --- | --- |
| `bot.stopped` | 200 | `Stopped` |
| `bot.kicked` | 200 | `Stopped` |
| `bot.notallowed` | 500 | `NotAllowed` |
| `bot.denied` | 500 | `Denied` |
| `bot.failed` | usually 500 | `FAILED` / `ERROR` / `Failed` |

Branch on `bot_event`, not on `status_code` or `bot_status`. `status_code: 500` also appears on `transcription.failed`.

---

## Stuck vs abandoned

Nothing in the webhook stream tells you a bot went quiet. The only way to notice is to watch the clock.

| | Meaning | Typical cause |
| --- | --- | --- |
| **stuck** | In one non-terminal state past that state's budget. Might still recover. | Long meeting, slow post-processing |
| **abandoned** | Silent for 4x the budget, or created with zero webhooks ever. Will not recover. | Unreachable `callback_url`, dead meeting link |

Budgets live in `STATE_TIMEOUTS_MS` in `src/machine.js`. Tune them to your own `automatic_leave` settings.

The most valuable finding is the ghost: a bot created through the API that never produced a single webhook.

```
lc-ghost-no-webhooks  ABANDONED  state=created
  why: No webhook has ever arrived for this bot. Almost always a callback_url
       that MeetStream cannot reach: it must be public HTTPS, and it is set
       per bot on create_bot.
```

There is no account-wide webhook setting. A bot created without `callback_url` produces nothing at all, forever.

## Persistence

`src/store.js` is deliberately small so you can swap it for your database. Two properties matter:

1. **State survives restarts.** An in-memory-only receiver forgets every in-flight bot on deploy, and then the monitor has nothing to reason about.
2. **Writes are atomic.** Write to `bots.json.tmp`, then `rename`. A crash mid-write cannot leave a truncated file that fails to parse on boot. A parse failure at load is logged and the process starts clean rather than dying.

Prove it:

```bash
node index.js --replay   # Ctrl+C
node index.js --report   # same ledger, new process
```

## How it works

```
index.js             CLI: receiver, --replay, --report, graceful flush
src/machine.js       STATES with ranks, STATE_TIMEOUTS_MS, targetStateFor(), applyEvent()
src/store.js         BotStore: JSON persistence, atomic writes, autoSave
src/server.js        webhook receiver, dedupe on bot_event ?? event + timestamp,
                     streaming_only stamp, terminal reporting
src/monitor.js       inspect / scan / startMonitor / report
src/scenarios.js     synthetic sequences: post-call, streaming, kicked, notallowed,
                     denied, failed, out-of-order + duplicate, deletion
src/logger.js        timestamped console output
```

`applyEvent(record, envelope)` is pure enough to unit test directly, and returns `{ moved, from, to, note }` so you can log exactly what the machine decided and why.

## Troubleshooting

**Every bot sits in `created`.** No webhooks are arriving. The `callback_url` must be public HTTPS and set per bot on `create_bot`.

**A bot never leaves `processing` or `media_ready`.** `bot.done` arrives on every path, streaming-only included, so a bot parked here is genuinely stalled or its `bot.done` delivery was lost. Check `GET /bots/{id}/detail`. Do not treat `audio.processed` as the end.

**States look like they are going backwards.** They are not. Look for `out-of-order` in the log: the machine recorded the event and refused the regression.

**`data/bots.json` is missing.** It is created on first write and gitignored. `--report` on an empty store just says so.

**Wrong stuck alerts.** Your budgets do not match your meetings. Edit `STATE_TIMEOUTS_MS`. If `waiting_room` fires constantly, align it with your `automatic_leave.waiting_room_timeout`.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
