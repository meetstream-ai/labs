#!/usr/bin/env bash
# lib.sh - shared helpers for the MeetStream skill scripts.
# Sourced by every script in this directory. Not meant to be run directly.

set -euo pipefail

# ---- config -----------------------------------------------------------
: "${MEETSTREAM_API_BASE:=https://api.meetstream.ai/api/v1}"
MEETSTREAM_API_BASE="${MEETSTREAM_API_BASE%/}"

# ---- optional .env auto-load -------------------------------------------
# If a .env file sits next to this skill (skill_root/.env), read the one
# supported assignment as data. Never source the file: a credential file is
# not trusted shell code. Exported env vars always win.
if [[ -z "${MEETSTREAM_API_KEY:-}" && -z "${MEETSTREAM_SKIP_DOTENV:-}" ]]; then
  _ms_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _ms_env_file="$(cd "$_ms_lib_dir/.." && pwd)/.env"
  if [[ -f "$_ms_env_file" ]]; then
    if [[ -L "$_ms_env_file" ]]; then
      echo "error: refusing to read symlinked credential file: $_ms_env_file" >&2
      exit 78
    fi
    _ms_key_count=0
    _ms_key_value=""
    while IFS= read -r _ms_line || [[ -n "$_ms_line" ]]; do
      if [[ -z "$_ms_line" || "$_ms_line" =~ ^[[:space:]]*$ || "$_ms_line" =~ ^[[:space:]]*# ]]; then
        continue
      fi
      case "$_ms_line" in
        MEETSTREAM_API_KEY=*)
          _ms_key_count=$((_ms_key_count + 1))
          _ms_key_value="${_ms_line#MEETSTREAM_API_KEY=}"
          ;;
        *)
          echo "error: unsupported entry in $_ms_env_file; only MEETSTREAM_API_KEY=... is allowed" >&2
          exit 78
          ;;
      esac
    done < "$_ms_env_file"
    if [[ "$_ms_key_count" -ne 1 || -z "$_ms_key_value" || "$_ms_key_value" == *$'\r'* ]]; then
      echo "error: $_ms_env_file must contain exactly one non-empty MEETSTREAM_API_KEY assignment" >&2
      exit 78
    fi
    MEETSTREAM_API_KEY="$_ms_key_value"
    export MEETSTREAM_API_KEY
  fi
  unset _ms_lib_dir _ms_env_file _ms_key_count _ms_key_value _ms_line
fi

ms_validate_api_base() {
  if [[ "$MEETSTREAM_API_BASE" == "https://api.meetstream.ai/api/v1" ]]; then
    return 0
  fi
  if [[ "${MEETSTREAM_TEST_MODE:-}" == "1" && "$MEETSTREAM_API_BASE" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/api/v1$ ]]; then
    return 0
  fi
  echo "error: MEETSTREAM_API_BASE must be https://api.meetstream.ai/api/v1 (loopback HTTP is allowed only with MEETSTREAM_TEST_MODE=1)" >&2
  exit 78
}

ms_validate_bot_id() {
  local bot_id="$1"
  if [[ ! "$bot_id" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]]; then
    echo "error: invalid BOT_ID" >&2
    exit 64
  fi
}

ms_validate_meeting_url() {
  local url="$1"
  case "$url" in
    https://meet.google.com/*|https://zoom.us/j/*|https://zoom.us/wc/*|https://*.zoom.us/j/*|https://*.zoom.us/wc/*|https://teams.microsoft.com/*|https://teams.live.com/*|https://teams.cloud.microsoft/*) return 0 ;;
    *)
      echo "error: --link must be an HTTPS Google Meet, Zoom, or Microsoft Teams meeting URL" >&2
      exit 64
      ;;
  esac
}

ms_require_option_value() {
  local option="$1" value="${2-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "error: $option requires a value" >&2
    exit 64
  fi
}

# ---- dependency checks --------------------------------------------------
ms_require_bin() {
  local bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: required binary '$bin' not found on PATH" >&2
    exit 127
  fi
}

ms_check_deps() {
  ms_require_bin curl
  ms_require_bin jq
}

ms_require_api_key() {
  if [[ -z "${MEETSTREAM_API_KEY:-}" ]]; then
    cat >&2 <<'EOF'
error: MEETSTREAM_API_KEY is not set.

Get an API key from https://app.meetstream.ai/api-key and export it:
  export MEETSTREAM_API_KEY="ms_live_..."

In OpenClaw, wire it through the skill's env entry in openclaw.json instead
of hardcoding it anywhere:
  skills.entries.meetstream.apiKey = { source: "env", ... }
EOF
    exit 78 # EX_CONFIG
  fi
}

# ---- HTTP wrapper --------------------------------------------------------
# ms_request METHOD PATH [BODY_JSON]
# Prints the response body on stdout. Non-2xx responses print the error
# body to stderr and return a non-zero exit code instead of throwing raw
# curl failures at the caller.
ms_request() {
  local method="$1" path="$2" body="${3:-}" idempotency_key="${4:-}"
  ms_validate_api_base
  local url="${MEETSTREAM_API_BASE}${path}"
  local tmp
  tmp="$(mktemp)"
  local http_code

  local -a curl_args=(
    -sS -o "$tmp" -w '%{http_code}'
    --connect-timeout 10 --max-time 60
    -X "$method"
    -H "Authorization: Token ${MEETSTREAM_API_KEY}"
  )

  if [[ "${MEETSTREAM_TEST_MODE:-}" == "1" ]]; then
    curl_args+=(--proto '=http,https')
  else
    curl_args+=(--proto '=https')
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" -d "$body")
  fi
  if [[ -n "$idempotency_key" ]]; then
    curl_args+=(-H "Idempotency-Key: $idempotency_key")
  fi

  curl_args+=("$url")

  if ! http_code="$(curl "${curl_args[@]}")"; then
    echo "error: request to $url failed (network error)" >&2
    rm -f "$tmp"
    exit 1
  fi

  if [[ "$http_code" == "507" && "$method" == "POST" && "$path" == "/bots/create_bot" && -n "$idempotency_key" ]]; then
    : # MeetStream uses 507 to return the original bot for an idempotent replay.
  elif [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "error: MeetStream API returned HTTP $http_code for $method $path" >&2
    if jq -e . >/dev/null 2>&1 <"$tmp"; then
      jq -r '.detail // .message // .error // .' <"$tmp" >&2
    else
      cat "$tmp" >&2
    fi
    rm -f "$tmp"
    exit 1
  fi

  if ! jq -e . >/dev/null 2>&1 <"$tmp"; then
    echo "error: MeetStream API returned a non-JSON success response for $method $path" >&2
    rm -f "$tmp"
    exit 1
  fi

  cat "$tmp"
  rm -f "$tmp"
}

ms_get()    { ms_request GET    "$1"; }
ms_post()   { ms_request POST   "$1" "${2:-}" "${3:-}"; }
ms_delete() { ms_request DELETE "$1" "${2:-}"; }

ms_validate_public_https_url() {
  local url="$1" label="${2:-URL}"
  if [[ ! "$url" =~ ^https://[^[:space:]/]+(/[^[:space:]]*)?$ ]]; then
    echo "error: $label must be a public HTTPS URL" >&2
    exit 64
  fi
}

# URL-encode a query parameter value (for list-bots.sh filters).
ms_urlencode() {
  local s="$1"
  jq -rn --arg s "$s" '$s|@uri'
}
