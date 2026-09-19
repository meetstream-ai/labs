# Bot configuration, media, storage and troubleshooting

Verified 2026-09-11. Use dedicated scripts where supported; for other fields
prepare a JSON object and use `api-request.sh POST /bots/create_bot --body-file FILE`.
Read [API-REFERENCE.md](API-REFERENCE.md) for the complete published schema.

## Deduplication

Reuse one persisted UUID `Idempotency-Key` for a logical creation and its
serialized retries. Creation is 201; replay is 507 and returns the original
bot. Never reuse it for another meeting: replay ignores the changed body.
`deduplication_key` is a body string of 1–2000 printable ASCII characters;
it returns 200 on replay and 409 if the meeting differs. Calendar scheduling
places it inside `bot_config`. When both exist the header wins. Keys remain
bound for the bot record's lifetime. Neither mechanism protects simultaneous
first creates; failed lookup can proceed with creation. Store the returned
bot ID and reconcile an uncertain result before retrying.
Source: [deduplication](https://docs.meetstream.ai/guides/features/deduplication-idempotency-keys).

## Automatic leave

All values are integer seconds. Service defaults and limits:

| Field | Default | Range |
| --- | ---: | --- |
| waiting_room_timeout | 600 | 60–600 Meet; 60–1200 Zoom; 60–1800 Teams |
| no_one_joined_timeout | 600 | 60–1800 |
| everyone_left_timeout | 300 | 60–1800 |
| voice_inactivity_timeout | 100 | container-enforced; guide suggests 60–1800 |
| in_call_recording_timeout | 14400 | 600–18000 |
| recording_permission_denied_timeout | 60 | 60–300; Zoom only |

The convenience script deliberately sends waiting-room=300, everyone-left=60,
recording-permission=60 and max duration=14400; these are package choices.
`automatic_leave.bot_detection.using_participant_names` optionally adds
`matches` (nonempty case-insensitive substrings), `activate_after` (60–1800,
default 300), and `timeout` (5–300, default 5). It leaves only when every
remaining non-self participant matches; a human returning cancels the timer.
Participant-event heuristics and silence_detection in bot_detection are unsupported.
Source: [automatic leave](https://docs.meetstream.ai/guides/features/automatic-leave-configuration).

## Transcription configuration

Set `recording_config.transcript.provider` to an object keyed by the provider.
Provider keys for MIA speech recognition are configured separately from these
recording transcription settings.

| Provider | Current model / key behavior |
| --- | --- |
| deepgram | nova-3; language en; diarize true; keywords and formatting options |
| assemblyai | speech_models:[universal-2]; language_code en_us; speaker_labels true; optional PII redaction, chapters, entities, keyterms |
| sarvam | saaras:v3; mode transcribe or translate; language_code en-IN; with_diarization true |
| meetstream | in-house; language auto; translate false |
| jigsawstack | language auto; translate false; by_speaker true |
| deepgram_streaming | nova-2 only; sentence/word/raw; language en; linear16 |
| assemblyai_streaming | universal-streaming-english; raw/sentence; 48000 Hz; pcm_s16le |
| meeting_captions | empty object; Meet/Teams only; caption availability depends on the meeting |

Sources: [provider comparison](https://docs.meetstream.ai/guides/transcription-recordings/providers/transcription-providers)
and each [provider's field reference](DOCS-INDEX.md). Full configurable fields,
types and defaults are bundled in openapi.json; don't substitute provider-native
models that MeetStream does not accept.

Live streaming providers require `live_transcription_required.webhook_url`.
Persist `new_text` increments and final turns carefully: `transcript` is a
running buffer, not a fresh independent segment. Payloads contain bot_id,
speakerName, timestamp, words with timing/confidence, end_of_turn, and attributes.
Source: [live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription).

Native captions have no transcript_id: read `bot_details.caption_file` via
bot-data detail and fetch the returned URL using a download client without
MeetStream auth. They must not be treated as a standard post-call transcript.
Source: [captions](https://docs.meetstream.ai/guides/transcription-recordings/providers/meeting-captions).

Post-call providers produce transcripts after processing. Use get-transcript
or list all runs with bot-data transcriptions; `--raw` requests provider output.
POST `/bots/{id}/transcribe` with `provider` to re-transcribe retained audio,
then follow the new transcript ID. Streaming/caption pipelines do not emit
transcription.processed or bot.done; re-transcribe if a post-call artifact is needed.
Sources: [post-call](https://docs.meetstream.ai/guides/transcription-recordings/post-call-transcription),
[transcribe endpoint](https://docs.meetstream.ai/api-reference/api-endpoints/transcription/transcribe-bot-audio).

Language codes and translation differ by provider: use the selected provider's
language field and supported mode, not a universal code. Platform speaker
isolation and provider diarization are distinct; speaker labels are not proof
of clean source separation.
Sources: [languages](https://docs.meetstream.ai/guides/transcription-recordings/languages-and-translation),
[diarization](https://docs.meetstream.ai/guides/transcription-recordings/diarization).

## Artifacts and live controls

Mixed audio is retained alongside requested separate tracks. Enable
`audio_separate_streams` and/or `video_separate_streams` at creation. Zoom audio
is isolated per microphone; Meet/Teams speaker attribution does not guarantee
equivalent isolation during overlapping speech. Read stream segments and
participant identifiers rather than assuming one continuous file per person.
Video includes participant cameras and screen shares with platform-specific
resolution/concurrency limits.
Sources: [per-person audio](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-audio),
[per-person video](https://docs.meetstream.ai/guides/transcription-recordings/per-participant-video).

Use bot-data audio/video/audio-streams/video-streams. Pending artifacts return
202; poll 10–30 seconds apart or use readiness events. Refetch expired links:
mixed audio and transcript downloads normally last one hour, video and
per-person streams ten minutes. Never send the MeetStream Token header to
storage download hosts. Custom storage guides give differing lifetimes, so
use the actual returned URL expiry rather than a hard-coded assumption.
Source: [recordings](https://docs.meetstream.ai/guides/transcription-recordings/retrieve-recordings).

GET participant and speaker-timeline data separately; display names can collide.
Use stable platform IDs and the documented timeline byte offsets to correlate
speech with audio, not name-only joins.
Source: [participants](https://docs.meetstream.ai/guides/features/participants-and-speaker-timeline).

Send chat through send-chat; POST `/bots/{id}/send_image` uses the documented
image payload for an in-meeting visual. Initial bot_message and bot_image_url
are creation settings. Read bot-data chats for recorded messages.
Source: [chat and visuals](https://docs.meetstream.ai/guides/features/chat-and-visuals).

For an admitted, recording Google Meet bot, POST pause_recording or
resume_recording with no body. Pause produces silence/black frames of the same
duration, preserving timestamps; it also silences live audio and per-person
tracks. A 200 accepted response is command acceptance, not independent evidence
of application. The guide documents Google Meet availability and 30 requests
per minute per bot; don't promise Zoom/Teams support from endpoint existence.
Source: [pause/resume](https://docs.meetstream.ai/guides/features/pause-resume-recording).

## Retention and usage

Set retention explicitly, for example `{"type":"timed","hours":24}`.
The usage guide says 24-hour default while OpenAPI says indefinite; do not
rely on either default. Meeting time drives usage, including lingering bots;
inspect dashboard Usage for per-bot costs and current pricing separately.
Expiry/deletion emits data_deletion and MediaExpired; subsequent artifacts
may return 404/410. DELETE `/bots/{id}/delete` deletes stored data; remove_bot
only ends participation. Custom attributes enable customer/job attribution.
Source: [usage](https://docs.meetstream.ai/guides/features/usage-and-retention).

Attributes are echoed in webhooks and can be filtered with `custom_attr[key]`
on bot listing. The script's repeatable `--attr` creates string values;
advanced JSON preserves numeric/object values if needed.
Source: [attributes](https://docs.meetstream.ai/guides/features/custom-attributes).

## Custom storage

PUT `/admin/configs?config_type=StorageConfig` with provider, bucket_name,
region, access_key_id, secret_key and optional access_mode/prefix/prefixes/
endpoint_url. AWS S3 and S3-compatible stores use provider aws; endpoint_url
supports stores such as R2/MinIO. Prefixes can vary for audio, video,
transcript and metadata. Grant narrowly scoped write/delete and, for
read_write, read permissions. write_only intentionally causes fetch API 403;
read artifacts using your own storage credentials. Configuration removal
changes future storage; it does not delete existing bucket objects.
Source: [S3 setup](https://docs.meetstream.ai/guides/features/custom-storage-configurations/amazon-s3).

Alibaba uses provider alibaba_oss and RAM credentials, with default endpoint
`https://s3.oss-<region>.aliyuncs.com`. Some mainland setups require an HTTPS
CNAME. Permit object probes and cleanup for validation; HeadBucket denial may
fall back to object checks. Only one custom provider is active; switching
preserves the original storage location for prior artifacts. OpenAPI's AWS-only
enum is behind this guide, so do not remove OSS support based on that enum.
Source: [OSS setup](https://docs.meetstream.ai/guides/features/custom-storage-configurations/alibaba-cloud-oss).

## Diagnose errors

Run doctor, status and detail. 400: inspect fields/platform constraints;
401: key; 403: workspace/access or write_only storage; 404: ID/deleted data;
409: incompatible bot state or schedule conflict; 429: back off; 500/503:
inspect upstream/runtime availability. 507 is a successful create replay only
in the idempotency context. HTTP 202 means processing, never a ready artifact.
Stopped/kicked/denied/notallowed/failed are participation terminals; processing
may continue afterward. See [WEBHOOKS.md](WEBHOOKS.md) before interpreting events.
Sources: [errors](https://docs.meetstream.ai/errors),
[debugging](https://docs.meetstream.ai/guides/help/debugging-bots).
