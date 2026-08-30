#!/usr/bin/env bash
# send-bot.sh - deploy a MeetStream bot (optionally powered by a MIA agent)
# into a Zoom / Google Meet / Microsoft Teams meeting.
#
# Usage:
#   send-bot.sh --link URL --name "Bot Name" [options]
#
# Required:
#   --link URL             Meeting URL (Zoom / Google Meet / Teams)
#   --name TEXT             Display name the bot joins with
#
# Optional:
#   --agent-id ID           MIA agent_config_id to power the bot
#   --agent-name TEXT       Resolve a MIA agent by (partial, case-insensitive)
#                           name instead of passing --agent-id directly
#   --video / --no-video    Record video (default: --video)
#   --message TEXT          Message the bot posts in meeting chat on join
#   --image-url URL         Bot avatar image URL
#   --callback-url URL      Webhook URL for lifecycle events
#   --join-at ISO8601       Schedule the bot instead of joining immediately
#   --transcription NAME    deepgram|assemblyai|sarvam|meetstream|jigsawstack|
#                           meeting_captions|deepgram_streaming|assemblyai_streaming
#   --language CODE         Provider language code (for example en, en_us, en-IN)
#   --retention-hours N     Retain recordings for N hours
#   --separate-audio        Capture per-participant audio streams
#   --separate-video        Capture per-participant video streams
#   --live-transcript URL   Send live transcript chunks to this HTTPS webhook
#   --idempotency-key UUID  Safe retry key; prevents duplicate bot creation
#   --max-seconds N         Maximum in-call recording duration (default 14400)
#   --attr KEY=VALUE        Custom attribute, repeatable
#   --json                  Print raw API JSON instead of a summary
#
# POST /api/v1/bots/create_bot

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

link=""
name=""
agent_id=""
agent_name=""
video_required=true
message=""
image_url=""
callback_url=""
join_at=""
transcription_provider=""
language=""
retention_hours=""
separate_audio=false
separate_video=false
live_transcript_webhook=""
idempotency_key=""
max_recording_seconds=14400
json_only=false
declare -a attr_pairs=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --link) ms_require_option_value "$1" "${2-}"; link="$2"; shift 2 ;;
    --name) ms_require_option_value "$1" "${2-}"; name="$2"; shift 2 ;;
    --agent-id) ms_require_option_value "$1" "${2-}"; agent_id="$2"; shift 2 ;;
    --agent-name) ms_require_option_value "$1" "${2-}"; agent_name="$2"; shift 2 ;;
    --video) video_required=true; shift ;;
    --no-video) video_required=false; shift ;;
    --message) ms_require_option_value "$1" "${2-}"; message="$2"; shift 2 ;;
    --image-url) ms_require_option_value "$1" "${2-}"; image_url="$2"; shift 2 ;;
    --callback-url) ms_require_option_value "$1" "${2-}"; callback_url="$2"; shift 2 ;;
    --join-at) ms_require_option_value "$1" "${2-}"; join_at="$2"; shift 2 ;;
    --transcription) ms_require_option_value "$1" "${2-}"; transcription_provider="$2"; shift 2 ;;
    --language) ms_require_option_value "$1" "${2-}"; language="$2"; shift 2 ;;
    --retention-hours) ms_require_option_value "$1" "${2-}"; retention_hours="$2"; shift 2 ;;
    --separate-audio) separate_audio=true; shift ;;
    --separate-video) separate_video=true; shift ;;
    --live-transcript) ms_require_option_value "$1" "${2-}"; live_transcript_webhook="$2"; shift 2 ;;
    --idempotency-key) ms_require_option_value "$1" "${2-}"; idempotency_key="$2"; shift 2 ;;
    --max-seconds) ms_require_option_value "$1" "${2-}"; max_recording_seconds="$2"; shift 2 ;;
    --attr) ms_require_option_value "$1" "${2-}"; attr_pairs+=("$2"); shift 2 ;;
    --json) json_only=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

ms_check_deps
ms_require_api_key

if [[ -z "$link" ]]; then
  echo "error: --link is required (the meeting URL)" >&2
  exit 64
fi
if [[ -z "$name" ]]; then
  echo "error: --name is required (the bot's display name)" >&2
  exit 64
fi
ms_validate_meeting_url "$link"
[[ -z "$callback_url" ]] || ms_validate_public_https_url "$callback_url" "--callback-url"
[[ -z "$image_url" ]] || ms_validate_public_https_url "$image_url" "--image-url"
[[ -z "$live_transcript_webhook" ]] || ms_validate_public_https_url "$live_transcript_webhook" "--live-transcript"

if [[ -n "$retention_hours" && ! "$retention_hours" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --retention-hours must be a positive integer" >&2
  exit 64
fi
if [[ ! "$max_recording_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --max-seconds must be a positive integer" >&2
  exit 64
fi
if [[ -n "$idempotency_key" && ! "$idempotency_key" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
  echo "error: --idempotency-key must be a UUID" >&2
  exit 64
fi

transcript_provider_json="{}"
case "$transcription_provider" in
  "") ;;
  deepgram) transcript_provider_json="$(jq -n --arg language "${language:-en}" '{deepgram:{model:"nova-3",language:$language,diarize:true}}')" ;;
  assemblyai) transcript_provider_json="$(jq -n --arg language "${language:-en_us}" '{assemblyai:{speech_models:["best"],language_code:$language,speaker_labels:true}}')" ;;
  sarvam) transcript_provider_json="$(jq -n --arg language "${language:-en-IN}" '{sarvam:{model:"saarika:v2",language_code:$language,mode:"batch",with_diarization:true}}')" ;;
  meetstream) transcript_provider_json="$(jq -n --arg language "${language:-auto}" '{meetstream:{language:$language,translate:false}}')" ;;
  jigsawstack) transcript_provider_json="$(jq -n --arg language "${language:-auto}" '{jigsawstack:{language:$language,translate:false,by_speaker:true}}')" ;;
  meeting_captions) transcript_provider_json='{"meeting_captions":{}}' ;;
  deepgram_streaming) transcript_provider_json="$(jq -n --arg language "${language:-en}" '{deepgram_streaming:{model:"nova-3",language:$language}}')" ;;
  assemblyai_streaming) transcript_provider_json='{"assemblyai_streaming":{}}' ;;
  *)
    echo "error: unsupported --transcription provider '$transcription_provider'" >&2
    exit 64
    ;;
esac

if [[ "$transcription_provider" == *_streaming && -z "$live_transcript_webhook" ]]; then
  echo "error: streaming transcription requires --live-transcript with a public HTTPS webhook" >&2
  exit 64
fi

# Resolve --agent-name to an agent_config_id if given.
if [[ -n "$agent_name" ]]; then
  if [[ -n "$agent_id" ]]; then
    echo "error: pass either --agent-id or --agent-name, not both" >&2
    exit 64
  fi
  agents_json="$(ms_get "/mia")"
  matches="$(jq -r --arg q "$agent_name" '
    [.agent_configs[] | select(.AgentName | ascii_downcase | contains($q | ascii_downcase))]
  ' <<<"$agents_json")"
  match_count="$(jq 'length' <<<"$matches")"
  if [[ "$match_count" -eq 0 ]]; then
    echo "error: no MIA agent name matches '$agent_name'. Run list-agents.sh to see options." >&2
    exit 1
  elif [[ "$match_count" -gt 1 ]]; then
    echo "error: '$agent_name' matches more than one MIA agent:" >&2
    jq -r '.[] | "  - \(.AgentName)  [id: \(.AgentConfigID)]"' <<<"$matches" >&2
    echo "Re-run with --agent-id to disambiguate." >&2
    exit 1
  fi
  agent_id="$(jq -r '.[0].AgentConfigID' <<<"$matches")"
fi

# Build custom_attributes object from --attr KEY=VALUE pairs.
custom_attrs="{}"
for pair in "${attr_pairs[@]+"${attr_pairs[@]}"}"; do
  key="${pair%%=*}"
  val="${pair#*=}"
  if [[ "$key" == "$pair" ]]; then
    echo "error: --attr must be KEY=VALUE, got '$pair'" >&2
    exit 64
  fi
  if [[ -z "$key" ]]; then
    echo "error: --attr key must not be empty" >&2
    exit 64
  fi
  custom_attrs="$(jq --arg k "$key" --arg v "$val" '. + {($k): $v}' <<<"$custom_attrs")"
done

payload="$(jq -n \
  --arg meeting_link "$link" \
  --arg bot_name "$name" \
  --argjson video_required "$video_required" \
  --arg bot_message "$message" \
  --arg bot_image_url "$image_url" \
  --arg agent_config_id "$agent_id" \
  --arg callback_url "$callback_url" \
  --arg join_at "$join_at" \
  --arg transcription_provider "$transcription_provider" \
  --argjson transcript_provider "$transcript_provider_json" \
  --arg retention_hours "$retention_hours" \
  --argjson separate_audio "$separate_audio" \
  --argjson separate_video "$separate_video" \
  --arg live_transcript_webhook "$live_transcript_webhook" \
  --argjson max_recording_seconds "$max_recording_seconds" \
  --argjson custom_attributes "$custom_attrs" \
  '
  {meeting_link: $meeting_link, bot_name: $bot_name, video_required: $video_required}
  + (if $bot_message != "" then {bot_message: $bot_message} else {} end)
  + (if $bot_image_url != "" then {bot_image_url: $bot_image_url} else {} end)
  + (if $agent_config_id != "" then {agent_config_id: $agent_config_id} else {} end)
  + (if $callback_url != "" then {callback_url: $callback_url} else {} end)
  + (if $join_at != "" then {join_at: $join_at} else {} end)
  + (if $separate_audio then {audio_separate_streams:true} else {} end)
  + (if $separate_video then {video_separate_streams:true} else {} end)
  + (if $live_transcript_webhook != "" then {live_transcription_required:{webhook_url:$live_transcript_webhook}} else {} end)
  + (if ($transcription_provider != "" or $retention_hours != "") then {
      recording_config:
        ({}
          + (if $transcription_provider != "" then {transcript:{provider:$transcript_provider}} else {} end)
          + (if $retention_hours != "" then {retention:{type:"timed",hours:($retention_hours|tonumber)}} else {} end))
    } else {} end)
  + {automatic_leave:{
      waiting_room_timeout:300,
      everyone_left_timeout:60,
      in_call_recording_timeout:$max_recording_seconds,
      recording_permission_denied_timeout:60
    }}
  + (if ($custom_attributes | length) > 0 then {custom_attributes: $custom_attributes} else {} end)
  ')"

resp="$(ms_post "/bots/create_bot" "$payload" "$idempotency_key")"

if $json_only; then
  echo "$resp"
  exit 0
fi

bot_id="$(jq -r '.bot_id // empty' <<<"$resp")"
status="$(jq -r '.status // empty' <<<"$resp")"
meeting_url="$(jq -r '.meeting_url // empty' <<<"$resp")"

if [[ -z "$bot_id" ]]; then
  echo "error: MeetStream did not return a bot_id. Raw response:" >&2
  echo "$resp" >&2
  exit 1
fi

echo "Bot dispatched."
echo "  bot_id:  $bot_id"
echo "  status:  ${status:-unknown}"
echo "  meeting: ${meeting_url:-$link}"
[[ -n "$agent_id" ]] && echo "  agent:   $agent_id"
echo
echo "Check progress with: bot-status.sh $bot_id"
