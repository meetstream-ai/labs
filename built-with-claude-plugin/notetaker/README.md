# notetaker

Paste a meeting link, a MeetStream bot joins, and you get a markdown brief —
summary, decisions, action items, open questions — written by an LLM.

```
notetaker join <url>  ──▶  MeetStream bot joins, records, transcribes
                                      │
                             webhook: transcription.processed
                                      ▼
                       notetaker serve  ──▶  fetch transcript
                                            ──▶  LlmProvider.complete()
                                            ──▶  briefs/YYYY-MM-DD-<bot_id>.md
```

## Setup

```bash
npm install
cp .env.example .env
openssl rand -hex 32        # paste into WEBHOOK_PATH_TOKEN
```

Fill in `MEETSTREAM_API_KEY` and `ANTHROPIC_API_KEY`. `TRANSCRIPT_PROVIDER`
defaults to `meetstream`, the in-house engine, which needs no external provider
key; `deepgram` and `assemblyai` only work once that key is on your MeetStream
account, and a missing one shows up as `transcription.failed` after the meeting
has already ended. The bot calls your server
over the public internet, so `PUBLIC_URL` must be a public HTTPS origin —
localhost never receives anything:

```bash
ngrok http 3000             # paste the https URL into PUBLIC_URL
```

## Use

```bash
npm run serve                                       # terminal 1
npx tsx src/cli.ts join https://meet.google.com/abc-defg-hij   # terminal 2
```

`serve` must be running and reachable *before* you `join`, since `callback_url`
is fixed per bot at creation time. The brief appears in `BRIEF_DIR` once the
transcript is ready — typically a minute or two after the meeting ends.

| Command | Does |
|---|---|
| `join <url>` | Sends a bot and prints its `bot_id` |
| `serve` | Runs the webhook server that writes briefs |
| `brief <bot_id>` | Re-runs the brief for a meeting that already finished |

`brief` is the one to use while iterating on the prompt: it re-reads the stored
transcript instead of needing another meeting. Transcripts are retained 7 days.

## Swapping the LLM

Providers sit behind `LlmProvider` in `src/llm/types.ts`:

```ts
export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<string>;
}
```

To add one: write the class, then add a line to `FACTORIES` in
`src/llm/index.ts` and a value to the `LLM_PROVIDER` enum in `src/config.ts`.
Nothing else knows which provider is in use. `LLM_PROVIDER=fake` returns a
canned brief, which is how the tests run the whole pipeline without a key.

## Cost

Bots are created with `video_required: false`. A notetaker only needs audio, and
video is the expensive half of a bot's runtime and storage. Retention is 7 days
(`retention.hours: 168`) so you can re-run `brief` without re-recording. If you
turn video on, you pay for it on every meeting.

## Webhook security

Per-bot `callback_url` deliveries from MeetStream are **unsigned**. The secret
path segment is what protects the route; HMAC verification is enforced only when
`WEBHOOK_SIGNING_SECRET` is set, which is the workspace-endpoint case. The
signature is `HMAC-SHA256(secret, raw body)`, sent as
`X-MeetStream-Signature: sha256=<hex>` with the timestamp in its own header.
Read [docs/webhook-security.md](docs/webhook-security.md) before exposing this
server.

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

The suite never touches the network: `MeetStreamClient` takes an injected
`fetch`, and the LLM is the fake provider. There is no MeetStream API key in the
test path, so `npm test` works on a machine that has never seen one.

## Changed after generation

A second Claude Code run fixed the webhook signature check (MeetStream signs the raw body only: `X-MeetStream-Signature: sha256=<HMAC-SHA256 hex>`) and made `meetstream` the default transcription provider, so no third-party key is needed. One hand fix after that: keys left blank in a copied `.env.example` are now treated as unset (`src/config.ts`).

## Run against the local mock (no API key, no meeting)

[`../mock-meetstream`](../mock-meetstream) is a small offline stand-in for the MeetStream API. It answers with the same request and response shapes, and it plays a short meeting (lifecycle webhooks, live transcript, post-call files) when asked. `mock_e2e.py` starts the mock, runs this app against it, and prints PASS or FAIL.

```bash
npm install
python3 mock_e2e.py            # per-bot callback_url (unsigned)
SIGNED=1 python3 mock_e2e.py   # signed workspace webhook
```
