# Bring Your Own S3 Bucket for MeetStream Meeting Recordings

Point the MeetStream API at **your own S3 bucket** (bring your own bucket / BYOB) so meeting bot recordings from Zoom, Google Meet and Microsoft Teams land there directly: audio, video, transcripts and metadata. This is a native account-level setting on `PUT /admin/configs`; once it is saved, MeetStream writes into your bucket itself and nothing is copied through this template.

## How it works

- `set` builds a storage config from `.env`, runs a local `HeadBucket` against your bucket, then saves the config with `PUT /admin/configs?config_type=storage` and reads it back with `GET /admin/configs`.
- `show` prints the current config. `delete --yes` removes it with `DELETE /admin/configs?key_name=aws`.
- `record` creates a bot for `MEETING_LINK`, waits for it to leave (webhook fast path, capped status poll as the guarantee), then lists `<prefix>/<bot_id>_*` in your bucket to prove the media arrived.
- The S3 secret key is read from the environment, sent to MeetStream once, and never printed.

## Why BYOB

- **Data residency** - the recording never rests outside the region and account your policy allows.
- **Your encryption keys** - bucket default encryption with a key you control and can revoke.
- **Your lifecycle rules** - tiering and expiry governed by your own retention policy, not a vendor setting.
- **Your audit trail** - CloudTrail data events on every read of a meeting recording.
- **Vendor exit** - the archive is already yours if you ever change providers.

## Read this before you run `set`

**This template sends S3 credentials to MeetStream.** That is what the feature is: MeetStream needs a key pair that can write into your bucket, so `PUT /admin/configs` carries `access_key_id` and `secret_key`, and MeetStream stores them on your account.

Treat that the way you would treat handing a key to any third party:

- Create a **dedicated IAM user** for this. Do not reuse an admin or CI key pair.
- Scope its policy to **one bucket and one prefix**, using the policy below.
- Put the secret in `.env` and nowhere else. `.env` is gitignored, `.env.example` holds placeholders only.
- Rotate it on the same schedule as your other shared credentials, and re-run `set` after each rotation.

This template never prints `secret_key`. Anything that displays a config runs through a redaction pass first, and `access_key_id` is shown masked down to its last four characters. `GET /admin/configs` does not return credential fields at all.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key from <https://app.meetstream.ai>
- An S3 bucket you own, plus a dedicated IAM key pair with the policy below
- Optional but recommended for `record`: a public HTTPS URL for webhooks, e.g. `ngrok http 3000`

## Setup

```bash
git clone https://github.com/meetstream-ai/labs.git
cd labs/custom-s3-storage
npm install
cp .env.example .env   # fill in MEETSTREAM_API_KEY and the S3_* values
node index.js set --dry-run   # prints the redacted request body, calls nothing
node index.js set             # saves the storage config
node index.js record          # runs a bot and confirms the files land in your bucket
```

## Commands

```
node index.js set              save the config, then read it back    (PUT then GET /admin/configs)
node index.js show             print the current config              (GET /admin/configs)
node index.js delete --yes     remove the config and credentials     (DELETE /admin/configs?key_name=aws)
node index.js record           run a bot, then list your bucket
node index.js --help           all options
```

`node index.js set --dry-run` prints the exact redacted request body without calling the API.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `MEETSTREAM_API_KEY` | yes | API key, sent as `Authorization: Token <key>`. |
| `S3_BUCKET` | yes | The bucket MeetStream writes into. Becomes `bucket_name`. |
| `S3_REGION` | yes | The bucket's actual region. Becomes `region`. |
| `S3_ACCESS_KEY_ID` | yes for `set` | IAM access key id. Stored on your MeetStream account. |
| `S3_SECRET_KEY` | yes for `set` | IAM secret key. Sent once, never logged. |
| `S3_ACCESS_MODE` | no | `read_write` (API default) or `write_only`. |
| `S3_PREFIX` | no | Base key prefix. API default `meetstream`. |
| `S3_PREFIX_AUDIO` | no | Per-category prefix override, sent in `prefixes.audio`. |
| `S3_PREFIX_VIDEO` | no | Override for `prefixes.video`. |
| `S3_PREFIX_TRANSCRIPT` | no | Override for `prefixes.transcript`. |
| `S3_PREFIX_METADATA` | no | Override for `prefixes.metadata`. |
| `S3_ENDPOINT_URL` | no | S3-compatible endpoint (R2, MinIO). Sent as `endpoint_url`. Omit for AWS S3. |
| `S3_FORCE_PATH_STYLE` | no | Local only: path-style addressing for the preflight and listing. Default `false`. |
| `MEETING_LINK` | yes for `record` | Zoom, Google Meet or Teams link the test bot joins. |
| `BOT_NAME` | no | Display name in the meeting. Default `MeetStream BYOB Recorder`. |
| `VIDEO_REQUIRED` | no | Record video as well as audio. Default `true`. |
| `EVERYONE_LEFT_TIMEOUT` | no | `automatic_leave.everyone_left_timeout` seconds. Default `60`. |
| `PUBLIC_WEBHOOK_URL` | no | Public HTTPS base; `callback_url` becomes `<url>/webhook`. Unset means poll-only. |
| `PORT` | no | Local webhook server port. Default `3000`. |
| `POLL_MAX_ATTEMPTS` | no | Cap for the status poll and the bucket listing poll. Default `80`. |
| `POLL_INTERVAL_MS` | no | Delay between polls. Default `15000`. |
| `REQUEST_TIMEOUT_MS` | no | Per-request timeout. Default `30000`. |
| `MAX_RETRIES` | no | Retries on network errors and 429/5xx. Default `4`. |
| `LOG_LEVEL` | no | `silent`, `error`, `warn`, `info` or `debug`. Default `info`. |
| `MEETSTREAM_API_BASE_URL` | no | API base. Default `https://api.meetstream.ai/api/v1`. |

## The storage config

`node index.js set` builds this body and sends it to `PUT /admin/configs?config_type=storage`:

```json
{
  "provider": "aws",
  "bucket_name": "my-company-meeting-recordings",
  "region": "us-west-2",
  "access_key_id": "AKIA...",
  "secret_key": "...",
  "access_mode": "read_write",
  "prefix": "meetstream",
  "prefixes": { "audio": "meetstream/audio", "video": "meetstream/video" },
  "endpoint_url": "https://<account>.r2.cloudflarestorage.com"
}
```

| Field | Required | Env var | Notes |
|---|---|---|---|
| `provider` | yes | | Always `aws`. It is the only value the API accepts. |
| `bucket_name` | yes | `S3_BUCKET` | The bucket you own. |
| `region` | yes | `S3_REGION` | Must be the bucket's actual region. |
| `access_key_id` | yes | `S3_ACCESS_KEY_ID` | Stored on your MeetStream account. |
| `secret_key` | yes | `S3_SECRET_KEY` | Credential. Env only, never logged. |
| `access_mode` | no | `S3_ACCESS_MODE` | `read_write` (default) or `write_only`. |
| `prefix` | no | `S3_PREFIX` | Base key prefix, default `meetstream`. |
| `prefixes` | no | `S3_PREFIX_AUDIO` etc. | Per-category overrides: audio, video, transcript, metadata. |
| `endpoint_url` | no | `S3_ENDPOINT_URL` | For S3-compatible stores. Omit for real AWS S3. |

**Key layout.** Objects are keyed `{prefix}/{bot_id}_<file>`, so everything for one bot shares a prefix search:

```
s3://my-company-meeting-recordings/meetstream/<bot_id>_audio.mp3
s3://my-company-meeting-recordings/meetstream/<bot_id>_video.mp4
```

Leading and trailing slashes on a prefix are stripped, and `..` segments are rejected. This template catches both locally so the error names the variable that is wrong.

**`access_mode` is the decision worth thinking about.**

- `read_write` (default) means MeetStream can read back out of your bucket, so `GET /bots/{id}/get_audio` and friends keep working exactly as they do on platform storage.
- `write_only` means MeetStream writes and never reads. Its fetch endpoints then return **403** for media that lives in your bucket. That is a stronger isolation guarantee, and it means your bucket becomes the only route to the recording. Plan your download path before you choose it.

**Validation happens at save time.** In `read_write` mode MeetStream performs a live `HeadBucket`. In `write_only` mode it writes a probe object under each configured prefix. So a `400` from `set` almost always means the bucket, region, or key pair is wrong, not that the JSON is malformed. This template also runs its own local `HeadBucket` first, so an obvious typo fails before any credential leaves your machine. Skip that with `--skip-preflight`.

**Config changes are not retroactive.** Setting, changing, or deleting the config only affects bots created afterwards. Media already written stays where it is. Recordings made before the config was set stay in MeetStream storage for their retention window (30 days unless you set one) and are still available through `GET /bots/{id}/get_audio` and `get_video`.

### S3-compatible stores

Set `S3_ENDPOINT_URL` to target Cloudflare R2, MinIO, or another S3-compatible store. It is sent to MeetStream as `endpoint_url`, and `provider` stays `aws` because the API's provider enum has one value. For the bucket checks this template runs locally you will usually also want `S3_FORCE_PATH_STYLE=true`.

## Required bucket permissions

The IAM user behind `S3_ACCESS_KEY_ID` needs the following. Nothing more.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ValidateAndListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-company-meeting-recordings"
    },
    {
      "Sid": "WriteRecordings",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::my-company-meeting-recordings/meetstream/*"
    }
  ]
}
```

Why each one:

| Action | Needed for |
|---|---|
| `s3:ListBucket` | MeetStream's `HeadBucket` validation when you save a `read_write` config, plus the local preflight and the `record` verification listing. Without it, a missing bucket and a permissions error are indistinguishable (both return 403). |
| `s3:PutObject` | MeetStream writing the media, and the probe objects it writes when validating a `write_only` config. |
| `s3:GetObject` | MeetStream serving media back through its own fetch endpoints in `read_write` mode. Drop it only if you are on `write_only` and accept that those endpoints will 403. |
| `s3:AbortMultipartUpload` | Large recordings upload in parts. Without this, a failed upload leaves billable orphan parts behind. |
| `s3:ListMultipartUploadParts` | Multipart completion. |

Adjust the resource ARN if you changed `S3_PREFIX`, and add each override from `prefixes` as its own resource line.

**With SSE-KMS**, the same principal also needs `kms:GenerateDataKey` and `kms:Decrypt` on the key, and the key policy must allow that principal.

**Bucket settings that matter:**

- **Block Public Access: ON, all four settings.** Meeting recordings must never be publicly readable. Share them with presigned URLs, not with a public ACL.
- **Default encryption: enabled** (SSE-S3 at minimum, SSE-KMS if you need key control). Setting it on the bucket means every object is encrypted regardless of how it was written.
- **Bucket Owner Enforced** object ownership (ACLs disabled) - the modern default, and it removes a whole class of cross-account ownership bugs.
- **Versioning**, if you want protection against accidental overwrite of a recording.
- **Lifecycle rule** with `AbortIncompleteMultipartUpload` after 1 to 7 days, so interrupted uploads do not accumulate silent storage charges.
- **Same region** as `S3_REGION`. A region mismatch surfaces as a confusing 301/404 during validation.

## What `record` does

1. **`GET /admin/configs`** to confirm a storage config is actually in place. If it comes back empty, the run warns loudly, because the bot would write to MeetStream's platform bucket and the verification step would find nothing.
2. **Create the bot** with an `Idempotency-Key`, and a `callback_url` when `PUBLIC_WEBHOOK_URL` is set.
3. **Wait for the bot to leave.** The `bot.stopped` webhook is the fast path (the reason is in its `bot_event`: `bot.stopped`, `bot.kicked`, `bot.notallowed`, `bot.denied` or `bot.failed`); a capped poll over `GET /bots/{id}/status` is the guarantee. `bot.done` is the final webhook on every path.
4. **List your bucket.** Post-processing runs after the bot leaves, so this polls `ListObjectsV2` on `<prefix>/<bot_id>_` until objects appear or the attempt budget runs out.

Both waits are capped at `POLL_MAX_ATTEMPTS` polls, `POLL_INTERVAL_MS` apart (defaults 80 x 15 s, about 20 minutes each). When a cap is hit the run logs `Gave up ...` with the numbers; the bot wait then continues to the bucket check, and the bucket wait exits with code 1.

Press `Ctrl+C` to pull the bot out of the meeting early. A second `Ctrl+C` exits immediately.

Pass `--skip-verify` to stop after step 3 and just print where to look.

## Removing the config

```bash
node index.js delete --yes
```

`DELETE /admin/configs?key_name=aws` removes the credentials and the configuration. New bots write to the MeetStream platform bucket again. **Files already in your bucket are not touched**, so if you want them gone you delete them yourself. `key_name` is `aws`, the only value the API accepts.

## MeetStream status codes

Auth is `Authorization: Token <key>`, literally `Token`, not `Bearer`. Errors are `{ "message": "..." }`.

| Status | Meaning | Behaviour |
|---|---|---|
| 200 / 201 | Success | Continue. `PUT` and `DELETE` return an empty body. |
| 202 | Still processing | Poll again (capped) |
| 400 | Validation | On `set`, usually a bad bucket, region, or key pair |
| 401 / 403 | Auth | Check `MEETSTREAM_API_KEY` |
| 429, 5xx | Transient | Retry with backoff |
| **507** | **Idempotent replay** | **Treated as success** |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing required environment variable "MEETSTREAM_API_KEY"` | No `.env` or empty key. Every command except `set --dry-run` checks this before any network call. | `cp .env.example .env` and paste your key. |
| `Missing required environment variable "S3_BUCKET"` (or `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_KEY`, `MEETING_LINK`) | A value the command needs is blank. | Fill it in `.env`. `MEETING_LINK` is only needed by `record`. |
| `S3_ACCESS_MODE must be one of read_write \| write_only` / `S3_PREFIX must not contain ".." path segments` / `S3_PREFIX cannot be only slashes` / `S3_ENDPOINT_URL is not a valid URL` | Local validation of the config body failed before anything was sent. | Fix the named variable. |
| `Environment variable "POLL_MAX_ATTEMPTS" must be a number` | A numeric setting has a non-numeric value. | Use plain integers for `POLL_*`, `PORT`, `REQUEST_TIMEOUT_MS`, `MAX_RETRIES`, `EVERYONE_LEFT_TIMEOUT`. |
| `MeetStream API error 401` / `403` | Key missing or rejected, or BYOB is not enabled on the account. | Check `MEETSTREAM_API_KEY`; contact support if the key is valid but `set` returns 403. |
| `MeetStream API error 400` from `set` | MeetStream validated the credentials against the bucket and the check failed: wrong region, bucket name typo, or a key pair without `s3:PutObject` on the prefix. | Run `set` without `--skip-preflight` so the local `HeadBucket` names the real problem first. |
| `MeetStream API error 400` from `record` | `create_bot` rejected the body: bad `MEETING_LINK`, or `EVERYONE_LEFT_TIMEOUT` outside the allowed range. | Use the full meeting URL; keep the timeout a positive number of seconds. |
| `MeetStream API error 404` | `GET /bots/{id}/status` or `remove_bot` for a bot id MeetStream does not know, or whose data was already deleted. `remove_bot` treats 404 as "already gone" and continues. | Nothing to fix for `remove_bot`. Elsewhere, check the bot id in the dashboard. |
| `MeetStream API error 409` | `create_bot` was retried with the same `Idempotency-Key` but a different body. | Re-run `record`; each run generates a fresh key. |
| `... -> 429 (...). Retrying in Nms (attempt x/4)` | Rate limited. The client honours `Retry-After` and backs off. | Wait; it retries up to `MAX_RETRIES` times, then fails with the API message. |
| `... -> 500` / `502` / `503` / `504` retried, then `MeetStream API error 5xx` | Transient server problem that outlasted `MAX_RETRIES`. | Re-run. Raise `MAX_RETRIES` if it keeps happening. |
| `GET /bots/<id>/status failed: timed out after 30000ms` | No response headers within `REQUEST_TIMEOUT_MS`, on every retry. | Check connectivity, or raise `REQUEST_TIMEOUT_MS`. |
| `Refusing to delete the storage config without --yes` | Safety check on `delete`. | Run `node index.js delete --yes`. |
| `Unknown option --foo` / `Unknown command "foo"` | Typo in the CLI. | `node index.js --help`. |
| `Gave up waiting for the bot after 80 status checks (about 20 minutes)` | The meeting outlasted `POLL_MAX_ATTEMPTS x POLL_INTERVAL_MS`. The run continues to the bucket check. | Raise `POLL_MAX_ATTEMPTS` or `POLL_INTERVAL_MS`, or press Ctrl+C to pull the bot out. |
| `Gave up: nothing appeared under s3://... after 80 listings` | Post-processing did not land anything in the poll budget, or the config was empty. Exit code 1. | Check `show`, then `GET /bots/{id}/detail`; raise `POLL_MAX_ATTEMPTS` for long recordings. |
| `Could not list s3://<bucket>: ...` | The local credentials cannot `ListObjectsV2`. | Add `s3:ListBucket` on the bucket ARN for the key pair in `.env`. |
| `listen EADDRINUSE` when `record` starts | Another process owns `PORT`. | Stop it or set `PORT`. |
| `record` shows only `[bot n/80] status:` lines and no `Bot is in the meeting.` | `PUBLIC_WEBHOOK_URL` unset (poll-only mode, which is fine) or not reachable by MeetStream. | Leave it unset, or point it at a public HTTPS tunnel and confirm `GET <url>/healthz` answers. |
| `Access denied on bucket ...` | The credentials lack `s3:ListBucket` on the bucket ARN. `arn:aws:s3:::bucket` and `arn:aws:s3:::bucket/*` are different resources. | Add the bucket ARN statement from the policy above. |
| `Bucket ... does not exist` | Usually a region mismatch. | Set `S3_REGION` to the bucket's actual region. |
| `show` prints `{}` | No storage config is set; bots write to the MeetStream platform bucket. | Run `node index.js set`. |
| `record` finds nothing in the bucket | No config, the bot did not record, or you are searching the wrong prefix (overrides in `prefixes` move artifacts). | Check `show`, then `GET /bots/{id}/detail`, then the prefix. |
| `record` ends with `bot.notallowed` or `bot.denied` | The bot was never admitted, or the host refused it. | Admit the bot from the lobby; no media exists for that run. |
| `get_audio` returns 403 but the file is in my bucket | `access_mode: write_only` working as designed. | Fetch from S3 directly, or switch to `read_write`. |
| `MeetStream API error 507` | Idempotent replay of an earlier `create_bot` with the same `Idempotency-Key`. | Nothing to fix; the original bot is returned. |
| Storage charges from nowhere | Orphaned multipart parts from interrupted uploads. | Add the `AbortIncompleteMultipartUpload` lifecycle rule. |

## Related

- [Set storage config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/set-storage-config)
- [Get storage config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/get-storage-config)
- [Delete storage config](https://docs.meetstream.ai/api-reference/api-endpoints/storage-config/delete-storage-config)
- [Custom storage: Amazon S3 guide](https://docs.meetstream.ai/guides/features/custom-storage-configurations/amazon-s3)
- [Retrieve recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings)
- [Usage and retention](https://docs.meetstream.ai/guides/features/usage-and-retention)
- [Error reference](https://docs.meetstream.ai/errors)
- [AWS: multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- Templates: [audio-recording-downloader](../audio-recording-downloader/README.md) and [video-recording-downloader](../video-recording-downloader/README.md) fetch media through MeetStream's own endpoints.
