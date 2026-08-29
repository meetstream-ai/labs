# custom-s3-storage

Point MeetStream at **your own S3 bucket** (bring your own bucket / BYOB) so bot media lands there directly. This is a native account-level setting: once it is configured, MeetStream writes audio, video, transcripts, and metadata into your bucket itself. Nothing is copied through this template.

```bash
npm install
cp .env.example .env   # then fill in the MeetStream key and your bucket details
node index.js set      # save the storage config
node index.js record   # run a bot and confirm the files land in your bucket
```

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

## Commands

```
node index.js set              save the config, then read it back    (PUT then GET /admin/configs)
node index.js show             print the current config              (GET /admin/configs)
node index.js delete --yes     remove the config and credentials     (DELETE /admin/configs?key_name=aws)
node index.js record           run a bot, then list your bucket
node index.js --help           all options
```

`node index.js set --dry-run` prints the exact redacted request body without calling the API.

## Prerequisites

- Node.js 18 or newer (uses built-in `fetch`)
- A MeetStream API key: https://app.meetstream.ai
- An S3 bucket you own, plus a dedicated IAM key pair with the policy below
- Optional but recommended for `record`: a public HTTPS URL for webhooks, e.g. `ngrok http 3000`

## Setup

```bash
npm install
cp .env.example .env
```

```env
MEETSTREAM_API_KEY=your_api_key_here
S3_BUCKET=my-company-meeting-recordings
S3_REGION=us-west-2
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_KEY=...
MEETING_LINK=https://meet.google.com/abc-defg-hij
PUBLIC_WEBHOOK_URL=https://your-subdomain.ngrok-free.app
```

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

**Config changes are not retroactive.** Setting, changing, or deleting the config only affects bots created afterwards. Media already written stays where it is.

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
3. **Wait for the bot to leave.** The `bot.stopped` webhook is the fast path; a capped poll over `GET /bots/{id}/status` is the guarantee.
4. **List your bucket.** Post-processing runs after the bot leaves, so this polls `ListObjectsV2` on `<prefix>/<bot_id>_` until objects appear or the attempt budget runs out.

Press `Ctrl+C` to pull the bot out of the meeting early. A second `Ctrl+C` exits immediately.

Pass `--skip-verify` to stop after step 3 and just print where to look.

## Removing the config

```bash
node index.js delete --yes
```

`DELETE /admin/configs?key_name=aws` removes the credentials and the configuration. New bots write to the MeetStream platform bucket again. **Files already in your bucket are not touched**, so if you want them gone you delete them yourself. `key_name` is `aws`, the only value the API accepts.

## MeetStream status codes

Auth is `Authorization: Token <key>` - literally `Token`, not `Bearer`. Errors are `{ "message": "..." }`.

| Status | Meaning | Behaviour |
|---|---|---|
| 200 / 201 | Success | Continue. `PUT` and `DELETE` return an empty body. |
| 202 | Still processing | Poll again (capped) |
| 400 | Validation | On `set`, usually a bad bucket, region, or key pair |
| 401 / 403 | Auth | Check `MEETSTREAM_API_KEY` |
| 429, 5xx | Transient | Retry with backoff |
| **507** | **Idempotent replay** | **Treated as success** |

## Troubleshooting

**`API error 400` from `set`** - MeetStream validated the credentials against the bucket and the check failed. Run `node index.js set` without `--skip-preflight` so the local `HeadBucket` runs first; it usually names the real problem. The three usual causes are a wrong region, a bucket name typo, and a key pair without `s3:PutObject` on the prefix.

**`Access denied on bucket ...`** - the credentials lack `s3:ListBucket` on the bucket ARN. Note that the bucket ARN and the object ARN are different resources: `arn:aws:s3:::bucket` versus `arn:aws:s3:::bucket/*`. A policy with only the second one fails the preflight.

**`Bucket ... does not exist`** - usually a region mismatch. `S3_REGION` must be the bucket's actual region.

**`show` prints `{}`** - no storage config is set. Bots are writing into the MeetStream platform bucket.

**`record` finds nothing in the bucket** - check `show` first. If the config is there, confirm the bot actually recorded (`GET /bots/{id}/detail`), and confirm you are searching the right prefix: overrides in `prefixes` put artifacts somewhere other than the base prefix.

**`get_audio` returns 403 but the file is in my bucket** - that is `access_mode: write_only` working as designed. MeetStream will not read back out of your bucket in that mode. Fetch from S3 directly, or switch to `read_write`.

**Storage charges from nowhere** - orphaned multipart parts from interrupted uploads. Add the `AbortIncompleteMultipartUpload` lifecycle rule.

## A note on the old relay approach

Earlier versions of this template downloaded each recording from MeetStream and re-uploaded it into the customer bucket, because the native storage endpoint was not documented. That workaround is gone. It cost a full extra round trip of every recording, left a second copy in MeetStream's storage for as long as the retention window ran, and needed a long-lived process babysitting each bot. `PUT /admin/configs` does the same job with no copy and no relay, so there is nothing left for the relay to add. If you have recordings from before the config was set, they stay in MeetStream's storage and you can pull them with the normal `GET /bots/{id}/get_audio` and `get_video` endpoints.

## Reference

- [MeetStream docs](https://docs.meetstream.ai)
- [API reference](https://docs.meetstream.ai/api-reference)
- [AWS: multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
