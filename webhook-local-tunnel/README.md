# Receive MeetStream Webhooks Locally with an ngrok or Cloudflare Tunnel

Get MeetStream meeting bot webhooks (Zoom, Google Meet and Microsoft Teams lifecycle events) delivering to a server on your laptop: opens a public HTTPS tunnel with `ngrok` or `cloudflared`, wires it into `callback_url` on `create_bot`, and proves delivery works with a self-test before you spend a bot on it.

```bash
npm install && node index.js
```

---

## What this does

1. Starts a webhook receiver on `localhost:PORT`
2. Spawns a public HTTPS tunnel (`ngrok` or `cloudflared`) and scrapes the URL out of its output
3. Refuses anything MeetStream cannot deliver to (`http://`, `localhost`, LAN addresses)
4. Runs a three-step self-test: URL shape, `GET /health` through the tunnel, then a real `POST` of a MeetStream-shaped envelope
5. Optionally creates a bot whose `callback_url` points at the tunnel (`--create-bot`)
6. Prints every delivery as it lands, and removes the bot on `Ctrl+C`

## Why you need this

MeetStream delivers webhooks from its own infrastructure over the public internet. It cannot reach `http://localhost:3000`. Two hard requirements:

- the URL must be **HTTPS**
- the host must be **publicly resolvable** (not `localhost`, not `127.0.0.1`, not `192.168.x.x`)

Each bot carries its own `callback_url` on `create_bot`, fixed at create time, and deliveries are not retried. So get the URL right before you create the bot.

## Prerequisites

- Node.js 18 or newer
- One tunnel CLI:
  - **ngrok** (`brew install ngrok`), plus a one-time `ngrok config add-authtoken <token>` using a free token from https://dashboard.ngrok.com/get-started/your-authtoken
  - **cloudflared** (`brew install cloudflared`), no account needed
- A MeetStream API key, only for `--create-bot`: https://app.meetstream.ai

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/webhook-local-tunnel
npm install
cp .env.example .env   # pick TUNNEL_PROVIDER; add MEETSTREAM_API_KEY only for --create-bot
node index.js
```

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | no | Local webhook receiver port (default `3000`) |
| `WEBHOOK_PATH` | no | Path the receiver listens on; `callback_url` is `<public url>` + this (default `/webhook`) |
| `TUNNEL_PROVIDER` | no | `ngrok` (default), `cloudflared` or `manual` |
| `TUNNEL_URL` | with `manual` | Your own public `https://` URL, no trailing slash |
| `TUNNEL_VERBOSE` | no | `true` prints raw tunnel CLI output (default `false`) |
| `MEETSTREAM_API_KEY` | with `--create-bot` | API key, sent as `Authorization: Token <key>` |
| `MEETSTREAM_BASE_URL` | no | API base URL (default `https://api.meetstream.ai/api/v1`) |
| `MEETING_LINK` | with `--create-bot` | Zoom, Google Meet or Teams link the test bot joins |
| `BOT_NAME` | no | Test bot display name (default `Tunnel Test Bot`) |
| `VIDEO_REQUIRED` | no | `true` records video as well as audio (default `false`) |
| `NO_COLOR` | no | Set to anything to disable coloured output |

## Run

```bash
# Tunnel + self-test, then sit and wait for deliveries.
node index.js

# Same, then create a real bot pointed at the tunnel.
node index.js --create-bot

# Skip the self-test.
node index.js --no-verify
```

Expected output:

```
=============================
  MeetStream webhook tunnel
=============================
             local server: http://localhost:3000
             webhook path: POST /webhook
             tunnel provider: ngrok

=======================
  Public URL is live
=======================
             public url: https://a1b2-203-0-113-7.ngrok-free.app
             callback_url: https://a1b2-203-0-113-7.ngrok-free.app/webhook

=======================
  Verifying delivery
=======================
  PASS  url is deliverable (https, public host)  
  PASS  GET /health through the tunnel  (HTTP 200)
  PASS  POST webhook through the tunnel  (HTTP 200, handler received it)
```

Inspect what has arrived:

```bash
curl localhost:3000/deliveries
```

---

## Choosing a provider

| | ngrok | cloudflared | manual |
| --- | --- | --- | --- |
| Account needed | yes, free | no | n/a |
| URL stability | stable on paid plans | new random URL each run | yours |
| Setup | `ngrok config add-authtoken` once | none | set `TUNNEL_URL` |
| Best for | day-to-day dev | one-off tests, CI | staging, or a tunnel you already run |

`manual` mode does not spawn anything. It takes `TUNNEL_URL` from your environment, validates it, and uses it. Use that when you run `ngrok` in a second terminal, or when you point at a deployed staging server.

## How the tunnel helper works

`src/tunnel.js` spawns the CLI and watches both stdout and stderr for the provider's URL pattern:

```js
ngrok:        ngrok http 3000 --log=stdout --log-format=logfmt
              -> matches https://<sub>.ngrok-free.app | .ngrok.io | .ngrok.dev

cloudflared:  cloudflared tunnel --url http://localhost:3000
              -> matches https://<sub>.trycloudflare.com
```

It fails fast and usefully instead of hanging:

- `ENOENT` on spawn prints per-OS install instructions
- an ngrok authtoken error is detected in the output and reported immediately rather than after the 30 second timeout
- process exit before a URL appears includes the last 800 characters of output

`assertDeliverable(url)` is the guard worth stealing for your own code. It rejects non-`https` schemes, `localhost`, `127.0.0.1`, `::1`, `.local`, and the RFC 1918 ranges, with a message that says which rule was broken.

## How the self-test works

The check that matters is step 3: a `POST` of a real-shaped envelope through the public URL, carrying a random `verify_nonce` in `custom_attributes`. The receiver resolves a promise when it sees that nonce. So the test passes only when the request actually traversed the tunnel and reached your handler code.

That distinction matters, because a tunnel can return `200` from an interstitial page while your handler never runs. The self-test catches that. A plain `curl` to `/health` does not.

The synthetic envelope has the same shape as a real delivery: `event` (always present), `bot_event` (the specific name, equal to `event` except on terminals), and an ISO 8601 `timestamp`. On a terminal, `event` is `bot.stopped` and `bot_event` carries the reason (`bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied`, `bot.failed`), so the receiver prints both, for example `bot.stopped (bot.kicked)`.

## How it works

```
index.js             CLI: tunnel, verify, optional --create-bot, clean shutdown
src/tunnel.js        spawn ngrok/cloudflared, scrape the URL, assertDeliverable()
src/server.js        tiny receiver, keeps raw bytes, resolves the self-test nonce
src/verify.js        the three reachability checks
src/meetstream.js    create_bot / remove_bot, `Token` auth
src/logger.js        timestamped console output
```

For a receiver that actually interprets the full lifecycle, use [../webhook-handler-complete](../webhook-handler-complete) and point its `PUBLIC_URL` at the tunnel this one gives you.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `"ngrok" is not installed or not on your PATH.` | Tunnel CLI missing | Install it, or switch `TUNNEL_PROVIDER` to `cloudflared` |
| `ngrok needs an authtoken.` | One-time ngrok setup not done | `ngrok config add-authtoken <token>` (free token at <https://dashboard.ngrok.com/get-started/your-authtoken>), once per machine |
| Timed out waiting for a public URL | Port conflict (another ngrok agent running, which the free plan does not allow) or a corporate proxy | Set `TUNNEL_VERBOSE=true` to see the raw CLI output |
| `callback_url must be https.` | The provider gave you an `http://` URL | Use the `https://` one it printed alongside it; MeetStream does not deliver over plain HTTP |
| `GET /health` passes but the `POST` self-test fails | Something between the tunnel and your process eats POSTs (ngrok free interstitial, or a proxy inspecting bodies) | The template already sends `ngrok-skip-browser-warning: true`; try `cloudflared` |
| `--create-bot` says `MEETSTREAM_API_KEY` or `MEETING_LINK` is missing | Not set in `.env` | Fill them in; the tunnel and self-test work without them |
| 401 / 403 on `create_bot` | 401 = no key sent, 403 = wrong key | Check the key for stray quotes |
| 400 on `create_bot` | Bad `MEETING_LINK` or a non-HTTPS `callback_url` | Use the full meeting URL; let the template build `callback_url` |
| Self-test passes but no bot events arrive | The bot was created without `callback_url`, the path does not match `WEBHOOK_PATH` (the server logs every unrouted request), or the bot points at an old tunnel URL | Create a new bot against the current URL; deliveries are not retried |
| Free tunnel URL changed after a restart | Expected; bots already created still point at the dead URL | Create a new bot against the new URL |

## Related

- [Local webhook server](https://docs.meetstream.ai/guides/webhooks/local-webhook-server)
- [Webhooks and events](https://docs.meetstream.ai/guides/webhooks/webhooks-and-events)
- [Webhook signature verification](https://docs.meetstream.ai/guides/webhooks/webhook-signature-verification)
- [Workspace webhooks](https://docs.meetstream.ai/guides/webhooks/workspace-webhooks)
- [Create bot](https://docs.meetstream.ai/api-reference/api-endpoints/bot-endpoints/create-bot)
- Related templates: [../webhook-handler-complete](../webhook-handler-complete), [../bot-lifecycle-state-machine](../bot-lifecycle-state-machine)
