#!/usr/bin/env bash
# Resolve a bot's transcript_id and fetch its post-call transcript.
# Usage: get-transcript.sh BOT_ID [--raw] [--json]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

bot_id=""
raw=false
json_only=false
for arg in "$@"; do
  case "$arg" in
    --raw) raw=true ;;
    --json) json_only=true ;;
    -*) echo "error: unknown flag '$arg'" >&2; exit 64 ;;
    *) [[ -z "$bot_id" ]] || { echo "error: pass exactly one BOT_ID" >&2; exit 64; }; bot_id="$arg" ;;
  esac
done

[[ -n "$bot_id" ]] || { echo "Usage: $(basename "$0") BOT_ID [--raw] [--json]" >&2; exit 64; }
ms_check_deps
ms_require_api_key
ms_validate_bot_id "$bot_id"
encoded_bot="$(ms_urlencode "$bot_id")"

transcript_id=""
detail="$(ms_get "/bots/$encoded_bot/detail")"
transcript_id="$(jq -r '.bot_details.transcript_id // .transcript_id // empty' <<<"$detail")"

if [[ -z "$transcript_id" ]]; then
  runs="$(ms_get "/bots/$encoded_bot/transcriptions")"
  transcript_id="$(jq -r '
    (.transcriptions // [])
    | (map(select((.status // "") | test("success|completed"; "i"))) + .)
    | .[0].transcript_id // empty
  ' <<<"$runs")"
fi

if [[ -z "$transcript_id" ]]; then
  echo "Transcript is not ready for bot $bot_id. Wait for transcription.processed, then try again." >&2
  exit 1
fi
ms_validate_bot_id "$transcript_id"
encoded_transcript="$(ms_urlencode "$transcript_id")"
resp="$(ms_get "/transcript/$encoded_transcript/get_transcript?raw=$raw")"

if $json_only || $raw; then
  echo "$resp"
  exit 0
fi

echo "Transcript for bot $bot_id"
echo "transcript_id: $transcript_id"
echo
echo "$resp" | jq -r '
  if type == "array" then .
  elif (.message | type) == "array" then .message
  elif (.transcript | type) == "array" then .transcript
  else [] end
  | .[]
  | [(.speaker // .speaker_name // "Speaker"), (.transcript // .text // "")]
  | "\(.[0]): \(.[1])"
'
