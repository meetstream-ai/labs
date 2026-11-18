# MeetStream notetaker

Sends a bot to a meeting, handles the `bot.done` webhook, pulls the transcript.
Migrated from Recall.ai.

```
cp .env.example .env   # add your MEETSTREAM_API_KEY
pip install -r requirements.txt && pytest
```

Send a bot:

```
python meetstream_app.py https://meet.google.com/abc-defg-hij
```

The webhook handler listens on `/webhooks/meetstream`; pass its public URL as
`webhook_url` to `send_bot()` and it goes out as `callback_url` on the bot.
`/webhooks/recall` stays mapped to the same handler so a callback URL already
configured elsewhere keeps working.

## Before and after

`recall_app.py` and `tests/test_recall_app.py` are the original Recall.ai version, kept so you can compare the two side by side. `meetstream_app.py` is the migrated app. The first migration copied Recall's payload shapes (`data.bot.id`, a wrapped transcript); a second Claude Code run fixed it to MeetStream's flat webhook body (`bot_id` at the top level), `GET /bots/{id}/detail` for the `transcript_id`, and the top-level transcript array.

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python mock_e2e.py
```
