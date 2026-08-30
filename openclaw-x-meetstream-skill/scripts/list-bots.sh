#!/usr/bin/env bash
# list-bots.sh - list bots in this workspace, optionally filtered.
#
# Usage:
#   list-bots.sh [--status STATUS] [--platform GMeet|Zoom|Teams]
#                [--from YYYY-MM-DD] [--to YYYY-MM-DD]
#                [--active] [--json]
#
# --active is a convenience filter (client-side, not an API param): it hides
# bots whose status text looks terminal (done/stopped/left/failed/expired/
# removed/not allowed) so you can see what's plausibly still "in the call".
# MeetStream's exact status vocabulary can change, so treat --active as a
# best-effort shortlist, not a guarantee - confirm with bot-status.sh before
# acting on a single result.
#
# GET /api/v1/bots

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

status=""
platform=""
from=""
to=""
active_only=false
json_only=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) ms_require_option_value "$1" "${2-}"; status="$2"; shift 2 ;;
    --platform) ms_require_option_value "$1" "${2-}"; platform="$2"; shift 2 ;;
    --from) ms_require_option_value "$1" "${2-}"; from="$2"; shift 2 ;;
    --to) ms_require_option_value "$1" "${2-}"; to="$2"; shift 2 ;;
    --active) active_only=true; shift ;;
    --json) json_only=true; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--status S] [--platform GMeet|Zoom|Teams] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--active] [--json]"
      exit 0
      ;;
    *) echo "error: unknown argument '$1'" >&2; exit 64 ;;
  esac
done

ms_check_deps
ms_require_api_key

path="/bots"
declare -a qs=()
[[ -n "$status" ]]   && qs+=("status=$(ms_urlencode "$status")")
[[ -n "$platform" ]] && qs+=("platform=$(ms_urlencode "$platform")")
[[ -n "$from" ]]     && qs+=("from=$(ms_urlencode "$from")")
[[ -n "$to" ]]       && qs+=("to=$(ms_urlencode "$to")")
if [[ ${#qs[@]} -gt 0 ]]; then
  path+="?$(IFS=\&; echo "${qs[*]}")"
fi

resp="$(ms_get "$path")"

if $active_only; then
  resp="$(jq '
    .bots |= [.[] | select(
      (.status // "") | ascii_downcase
      | test("done|stop|left|error|fail|expired|not.?allowed|removed") | not
    )]
  ' <<<"$resp")"
fi

if $json_only; then
  echo "$resp"
  exit 0
fi

count="$(jq '.bots | length' <<<"$resp")"
if [[ "$count" -eq 0 ]]; then
  if $active_only; then
    echo "No bots currently look active."
  else
    echo "No bots matched."
  fi
  exit 0
fi

echo "$resp" | jq -r '
  .bots[] |
  "- \(.bot_id // .id // "?")  status: \(.status // "?")  " +
  (if .meeting_url then "meeting: \(.meeting_url)" else "" end)
'
