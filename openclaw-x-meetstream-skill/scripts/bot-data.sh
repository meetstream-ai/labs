#!/usr/bin/env bash
# Read meeting artifacts collected by a MeetStream bot.
# Usage: bot-data.sh detail|summary|participants|chats|speakers|audio|video|audio-streams|video-streams|screenshots|transcriptions BOT_ID [--json]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

kind="${1:-}"
bot_id="${2:-}"
json_only=false
[[ "${3:-}" == "--json" ]] && json_only=true

if [[ -z "$kind" || -z "$bot_id" || $# -gt 3 || ( $# -eq 3 && "${3:-}" != "--json" ) ]]; then
  echo "Usage: $(basename "$0") detail|summary|participants|chats|speakers|audio|video|audio-streams|video-streams|screenshots|transcriptions BOT_ID [--json]" >&2
  exit 64
fi

ms_check_deps
ms_require_api_key
ms_validate_bot_id "$bot_id"
encoded="$(ms_urlencode "$bot_id")"

case "$kind" in
  detail) path="/bots/$encoded/detail" ;;
  summary) path="/bots/$encoded/summary" ;;
  participants) path="/bots/$encoded/get_participants" ;;
  chats) path="/bots/$encoded/get_chats" ;;
  speakers) path="/bots/$encoded/get_speaker_timeline" ;;
  audio) path="/bots/$encoded/get_audio" ;;
  video) path="/bots/$encoded/get_video" ;;
  audio-streams) path="/bots/$encoded/get_audio_streams" ;;
  video-streams) path="/bots/$encoded/get_recording_streams" ;;
  screenshots) path="/bots/$encoded/get_screenshots" ;;
  transcriptions) path="/bots/$encoded/transcriptions" ;;
  *) echo "error: unknown data kind '$kind'" >&2; exit 64 ;;
esac

resp="$(ms_get "$path")"
if $json_only; then
  echo "$resp"
else
  echo "MeetStream $kind for bot $bot_id"
  echo "$resp" | jq
fi
