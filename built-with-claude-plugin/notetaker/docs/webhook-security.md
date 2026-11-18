# Webhook security

## The thing to know first

MeetStream signs **workspace-level** webhook endpoints with an HMAC signature.
Deliveries to a **per-bot `callback_url`** — which is what `notetaker join`
creates — are **not signed**.

So "verify the signature on everything MeetStream sends me" is not achievable on
the per-bot path alone. There is no signature on those requests to verify. This
app therefore runs two guards, and which one does the work depends on how you
point MeetStream at the server.

## Guard 1 — secret path segment (always on)

The webhook route is `/webhook/meetstream/:token`, where the token is
`WEBHOOK_PATH_TOKEN` — 32 random bytes from `openssl rand -hex 32`. The route is
registered as a *parameter* and the token compared with `timingSafeEqual`, so
the match is constant-time rather than Express's own string compare.

A wrong token gets a `404`, not a `401`: a caller probing the server learns
nothing about whether the route exists.

This is the only thing standing between the open internet and your handler on
the per-bot path. Consequences:

- Treat `WEBHOOK_PATH_TOKEN` like a password. It appears in `callback_url`, so
  it is stored by MeetStream and will show up in your own logs. Rotate it by
  changing `.env` and restarting; bots already in flight keep the old URL and
  will start getting 404s.
- The payload is still untrusted input. Everything is parsed through a zod
  schema (`src/webhook/events.ts`) and the handler only ever reads `bot_id` from
  it to call back out to the MeetStream API — it never trusts transcript content
  from the request body.

## Guard 2 — HMAC signature (on when `WEBHOOK_SIGNING_SECRET` is set)

Set `WEBHOOK_SIGNING_SECRET` and every delivery must carry a valid signature or
it is rejected with `401`. Use this when you configure a workspace-level
endpoint. Leave it blank for the per-bot flow — unsigned deliveries would all be
rejected.

### How MeetStream signs

A signed delivery carries two headers:

```
X-MeetStream-Signature: sha256=<hex digest>
X-MeetStream-Timestamp: <ISO-8601>
```

where the digest is `HMAC-SHA256(secret, raw_request_body)`. The **timestamp is
not part of the signed string** — it exists so you can bound replays. Verify by
stripping the `sha256=` prefix, recomputing the HMAC over the raw body, and
comparing in constant time.

`src/webhook/signature.ts` implements exactly that:

- HMAC-SHA256 over the raw body alone, hex digest, `sha256=` prefix optional
- the **raw** bytes, captured in `express.json({ verify })` before parsing —
  re-serialising the parsed object would not reproduce the signed bytes
- constant-time digest comparison (`timingSafeEqual`)
- a timestamp freshness window (`WEBHOOK_TOLERANCE_SECONDS`, default 300s) so a
  captured delivery cannot be replayed indefinitely. A delivery with no
  timestamp header is rejected (`reason: "missing_timestamp"`)
- header names from config, in case a workspace endpoint is fronted by a proxy
  that renames them

> This app previously signed `"<timestamp>.<raw body>"` — the Stripe-style
> construction — which rejected every genuine delivery with
> `"Rejected webhook signature"` / `reason: "mismatch"`. `tests/signature.test.ts`
> pins the correct construction and keeps a case that fails the old one.

If you do see `reason: "mismatch"` in the logs now, the likely causes are a
secret that does not match the one on the workspace endpoint, or a proxy that
re-encodes the body in flight.

## What is deliberately not here

- **No inbound ports beyond the one webhook route.** `/healthz` returns a bare
  `{"status":"ok"}` with no build or config detail.
- **Payloads log at DEBUG only** (`logger.debug('Webhook received', ...)`).
  At the default `LOG_LEVEL=info` no meeting content reaches the logs.
- **Body size is capped** at 1 MiB, far above any real event, so a large POST
  cannot exhaust memory.
- **Dedupe is in-memory** and bounded at 1000 keys, keyed on
  `bot_id:event:bot_event:timestamp`. That is correct for one process. If you
  ever run more than one instance, move it to Redis — two processes will
  otherwise each handle the same delivery and write the brief twice.
