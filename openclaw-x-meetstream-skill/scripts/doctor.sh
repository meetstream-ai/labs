#!/usr/bin/env bash
# doctor.sh - one-shot health check for this skill. Run this first whenever
# something isn't working, instead of debugging blind.
#
# Usage: doctor.sh [--json]
#
# Checks, in order: required binaries -> API key presence -> live auth
# against MeetStream (a cheap GET /mia call) -> whether OpenClaw itself can
# see this skill. Exits 0 when all required checks pass; unavailable optional
# discovery checks are reported as skipped.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

json_only=false
case "${1:-}" in
  "") ;;
  --json) json_only=true ;;
  -h|--help) echo "Usage: $(basename "$0") [--json]"; exit 0 ;;
  *) echo "error: unknown argument '$1'" >&2; exit 64 ;;
esac

declare -a results=()   # "check|status|detail"
overall_ok=true

record() {
  local check="$1" status="$2" detail="$3"
  results+=("${check}|${status}|${detail}")
  [[ "$status" == "fail" ]] && overall_ok=false
}

# 1. curl / jq present
if command -v curl >/dev/null 2>&1; then
  record "curl" "ok" "$(curl --version | head -n1)"
else
  record "curl" "fail" "not found on PATH. macOS ships curl by default - check your PATH."
fi

if command -v jq >/dev/null 2>&1; then
  record "jq" "ok" "$(jq --version)"
else
  record "jq" "fail" "not found on PATH. macOS: brew install jq. Windows/WSL Ubuntu: sudo apt-get install jq"
fi

# 2. API key present (checks .env auto-load path too, via lib.sh)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh" 2>/dev/null || true
set +e  # lib.sh turns on -e when sourced; doctor.sh needs to keep checking after failures
if [[ -n "${MEETSTREAM_API_KEY:-}" ]]; then
  record "api_key" "ok" "MEETSTREAM_API_KEY is set"
else
  record "api_key" "fail" "MEETSTREAM_API_KEY is not set. Run ./install.sh, or: cp .env.example .env && edit it, or export MEETSTREAM_API_KEY=... in your shell profile."
fi

# 3. Live auth check (only if we have curl+jq+key)
if [[ -n "${MEETSTREAM_API_KEY:-}" ]] && command -v curl >/dev/null 2>&1; then
  ms_validate_api_base
  doctor_tmp_dir="$(mktemp -d)"
  chmod 700 "$doctor_tmp_dir"
  doctor_resp="$doctor_tmp_dir/response"
  doctor_err="$doctor_tmp_dir/error"
  trap 'rm -rf "$doctor_tmp_dir"' EXIT HUP INT TERM
  http_code="$(curl -sS -o "$doctor_resp" -w '%{http_code}' --connect-timeout 10 --max-time 60 \
    -H "Authorization: Token ${MEETSTREAM_API_KEY}" \
    "${MEETSTREAM_API_BASE}/mia" 2>"$doctor_err")"
  if [[ "$http_code" == "200" ]]; then
    record "api_connectivity" "ok" "Authenticated successfully against ${MEETSTREAM_API_BASE}"
  elif [[ "$http_code" == "401" || "$http_code" == "403" ]]; then
    record "api_connectivity" "fail" "MeetStream rejected the API key (HTTP $http_code). Check https://app.meetstream.ai/api-key"
  elif [[ -z "$http_code" || "$http_code" == "000" ]]; then
    record "api_connectivity" "fail" "Could not reach ${MEETSTREAM_API_BASE} (network error). $(cat "$doctor_err" 2>/dev/null)"
  else
    record "api_connectivity" "fail" "Unexpected HTTP $http_code from ${MEETSTREAM_API_BASE}/mia"
  fi
  rm -rf "$doctor_tmp_dir"
  trap - EXIT HUP INT TERM
else
  record "api_connectivity" "skip" "skipped (missing curl or API key)"
fi

# 4. OpenClaw discovery (best-effort; not fatal if openclaw CLI isn't on PATH)
if [[ "${MEETSTREAM_SKIP_OPENCLAW_DISCOVERY:-}" == "1" ]]; then
  record "openclaw_discovery" "skip" "skipped by MEETSTREAM_SKIP_OPENCLAW_DISCOVERY=1"
elif command -v openclaw >/dev/null 2>&1; then
  if openclaw skills list --json 2>/dev/null | jq -e '.skills[] | select(.name == "meetstream" and .eligible == true)' >/dev/null; then
    record "openclaw_discovery" "ok" "OpenClaw reports meetstream as eligible"
  else
    record "openclaw_discovery" "fail" "OpenClaw does not report meetstream as eligible. Run ./install.sh, configure curl/jq, then restart the gateway."
  fi
else
  record "openclaw_discovery" "skip" "openclaw CLI not found on PATH - skipping (fine if you're only testing scripts directly)"
fi

if $json_only; then
  printf '['
  first=true
  for r in "${results[@]}"; do
    IFS='|' read -r check status detail <<<"$r"
    $first || printf ','
    first=false
    jq -cn --arg c "$check" --arg s "$status" --arg d "$detail" '{check:$c,status:$s,detail:$d}' 2>/dev/null \
      || printf '{"check":"%s","status":"%s"}' "$check" "$status"
  done
  printf ']\n'
  $overall_ok
  exit $?
fi

echo "MeetStream skill doctor"
echo "========================"
for r in "${results[@]}"; do
  IFS='|' read -r check status detail <<<"$r"
  case "$status" in
    ok)   mark="✓" ;;
    skip) mark="-" ;;
    *)    mark="✗" ;;
  esac
  printf "%s %-18s %s\n" "$mark" "$check" "$detail"
done
echo
if $overall_ok; then
  echo "All checks passed. Try: scripts/list-agents.sh"
else
  echo "One or more checks failed - see ✗ lines above for the fix."
fi

$overall_ok
