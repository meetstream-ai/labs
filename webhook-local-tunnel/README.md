# webhook-local-tunnel

Get MeetStream webhooks delivering to a server on your laptop: opens a public HTTPS tunnel, wires it into `callback_url`, and proves delivery works before you spend a bot on it.

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

There is also **no account-wide webhook setting**. Every bot carries its own `callback_url` on `create_bot`. A bot created without one produces no webhooks at all.

## Prerequisites

- Node.js 18 or newer
- One tunnel CLI:
  - **ngrok** (`brew install ngrok`), plus a one-time `ngrok config add-authtoken <token>` using a free token from https://dashboard.ngrok.com/get-started/your-authtoken
  - **cloudflared** (`brew install cloudflared`), no account needed
- A MeetStream API key, only for `--create-bot`: https://app.meetstream.ai

## Setup

```bash
cp .env.example .env
npm install
```

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

The synthetic envelope uses `"event"` as the key, because that is what MeetStream sends. Anything that says `bot_event` is wrong.

## How it works

```
index.js             CLI: tunnel, verify, optional --create-bot, clean shutdown
src/tunnel.js        spawn ngrok/cloudflared, scrape the URL, assertDeliverable()
src/server.js        tiny receiver, keeps raw bytes, resolves the self-test nonce
src/verify.js        the three reachability checks
src/meetstream.js    create_bot / remove_bot, `Token` auth
src/logger.js        timestamped console output
```

For a receiver that actually interprets the full lifecycle, use the `webhook-handler-complete` template and point its `PUBLIC_URL` at the tunnel this one gives you.

## Troubleshooting

**`"ngrok" is not installed or not on your PATH.`** Install it, or switch `TUNNEL_PROVIDER` to `cloudflared`.

**`ngrok needs an authtoken.`** Run `ngrok config add-authtoken <token>`. The free token is at https://dashboard.ngrok.com/get-started/your-authtoken. This is once per machine, not once per project.

**Timed out waiting for a public URL.** Set `TUNNEL_VERBOSE=true` to see raw CLI output. Usually a port conflict (another ngrok agent already running, which the free plan does not allow) or a corporate proxy.

**`callback_url must be https.`** MeetStream does not deliver over plain http. If your provider gave you an http URL, use the https one it printed alongside it.

**`GET /health` passes but the `POST` self-test fails.** Something between the tunnel and your process is eating POSTs. On ngrok free this is usually the browser interstitial. The template already sends `ngrok-skip-browser-warning: true`. If you are behind a corporate proxy that inspects POST bodies, try `cloudflared` instead.

**Tunnel is up, self-test passes, but no bot events arrive.** Check three things: the bot was created with `callback_url` set (there is no global webhook setting), the path in `callback_url` matches `WEBHOOK_PATH` exactly (the server logs every unrouted request), and the tunnel is the same one from this run (free tunnel URLs change on every restart, so a bot created against an old URL delivers into the void).

**Free tunnel URL changed after a restart.** Expected. Bots already created still point at the dead URL. Create a new bot against the new URL.

## Resources

- MeetStream Docs: https://docs.meetstream.ai
- API Reference: https://docs.meetstream.ai/api-reference
