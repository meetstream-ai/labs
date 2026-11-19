# mock-meetstream

A small offline stand-in for the MeetStream REST API, used by the `mock_e2e.py` check in each app. Python standard library only.

```bash
python3 mock_meetstream.py --port 8787 --log requests.jsonl
# point an app at it
MEETSTREAM_BASE_URL=http://127.0.0.1:8787/api/v1
```

- Every `/api/v1` call needs `Authorization: Token <anything>`, like the real API.
- Request and response shapes follow the public [OpenAPI spec](https://docs.meetstream.ai/openapi.json). A path the real API does not have answers 404 and is marked `"unknown": true` in the log.
- `POST /__mock/simulate/<bot_id>` plays a short meeting for that bot: lifecycle webhooks to its `callback_url` (unsigned), live transcript chunks to `live_transcription_required.webhook_url`, then post-call events. Body `{"stage": "join"}` stops with the bot in the meeting; `{"stage": "end"}` finishes it.
- `GET /__mock/log` returns every call; `GET /__mock/state` shows bots, hand state and chat messages the bot sent.

Switches (environment variables): `MOCK_RATE_LIMIT_PER_MIN=N` returns 429 with `Retry-After` after N bot creates per minute; `MOCK_TIMELINE_URL_FORM=1` makes `get_speaker_timeline` answer with a `speaker_timeline_url` download link (what the API does for very long meetings); `MOCK_TUNNEL=1` delivers `https://127.0.0.1:<port>` webhooks over plain HTTP (it stands in for your tunnel); `MOCK_WORKSPACE_WEBHOOK_URL` plus `MOCK_WEBHOOK_SECRET` also sends every event, signed, to a workspace webhook; `MOCK_MEDIA_TLS=cert.pem:key.pem` serves download links over https (real download links are https); `MOCK_NO_BYOK=1` acts as an account with no provider keys saved, so a voice agent config that names providers without `key_source: "meetstream"` gets the API's 400.

It is a test double, not the API: it checks the common request rules, not all of them.
