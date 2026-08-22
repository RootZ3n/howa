#!/bin/bash
set -euo pipefail

workspace="${HOWA_DAILY_DRIVER_WORKSPACE:?missing HOWA_DAILY_DRIVER_WORKSPACE}"
capture_root="${HOWA_DAILY_DRIVER_CAPTURE_ROOT:?missing HOWA_DAILY_DRIVER_CAPTURE_ROOT}"
runtime_kind="${HOWA_TRUSTED_RUNTIME_KIND:?missing trusted runtime kind}"
credential_name="${HOWA_PROVIDER_CREDENTIAL_NAME:-}"
workspace_real="$(realpath -- "$workspace")"
capture_real="$(realpath -- "$capture_root")"
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

case "$workspace_real" in /tmp/howa-ddv1-*/fixture-attempt-*) ;; *) echo "refusing non-Howa fixture: $workspace_real" >&2; exit 78 ;; esac
case "$capture_real" in /tmp/howa-ddv1-capture-*) ;; *) echo "refusing non-Howa capture root: $capture_real" >&2; exit 78 ;; esac
case "$capture_real" in "$workspace_real"|"$workspace_real"/*) echo "capture root overlaps candidate fixture" >&2; exit 78 ;; esac

case "$runtime_kind" in
  production-hermes)
    case "$credential_name" in
      MINIMAX_API_KEY|MIMO_API_KEY|OPENAI_API_KEY|HOWA_OPENAI_CODEX_AUTH_BUNDLE) ;;
      *) echo "provider credential is not allowlisted: $credential_name" >&2; exit 78 ;;
    esac
    credential_value="${!credential_name-}"
    [[ -n "$credential_value" ]] || { echo "required provider credential is unavailable: $credential_name" >&2; exit 78; }
    runtime_executable=/home/zen/.local/bin/hermes
    ;;
  offline-proof)
    [[ -z "$credential_name" ]] || { echo "offline proof refuses provider credentials" >&2; exit 78; }
    credential_value=""
    runtime_executable="$script_root/hermes-daily-driver-offline.mjs"
    ;;
  *) echo "unrecognized trusted runtime kind" >&2; exit 78 ;;
esac

provider_env=()
if [[ "$runtime_kind" == offline-proof ]]; then
  :
elif [[ "$credential_name" == HOWA_OPENAI_CODEX_AUTH_BUNDLE ]]; then
  [[ -s "$capture_real/auth.json" ]] || { echo "isolated Codex auth bundle was not minted" >&2; exit 78; }
else
  provider_env+=("$credential_name=$credential_value")
fi

mkdir -p "$capture_real/home" "$capture_real/cache" "$capture_real/data" "$capture_real/tmp"
chmod 700 "$capture_real" "$capture_real/home" "$capture_real/cache" "$capture_real/data" "$capture_real/tmp"

# Hermes retains provider/network authority. Its only candidate-facing toolset
# is terminal/process; bash resolution is forced through the air-gapped shim.
exec env -i \
  HOME="$capture_real/home" \
  PATH="$script_root/daily-driver-bin:/home/zen/.local/bin:/usr/bin:/bin" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  HOWA_DAILY_DRIVER=1 \
  HOWA_DAILY_DRIVER_WORKSPACE="$workspace_real" \
  HOWA_DAILY_DRIVER_CAPTURE_ROOT="$capture_real" \
  HOWA_TRIAL_ID="${HOWA_TRIAL_ID:?missing trusted trial identity}" \
  HOWA_TRUSTED_OFFLINE_SCENARIO="${HOWA_TRUSTED_OFFLINE_SCENARIO:-}" \
  HOWA_REQUESTED_MODEL_ID="${HOWA_REQUESTED_MODEL_ID:-}" \
  HOWA_ATTEMPT="${HOWA_ATTEMPT:-1}" \
  HERMES_HOME="$capture_real" \
  HERMES_SESSION_DIR="$capture_real" \
  HERMES_STATE_DIR="$capture_real" \
  XDG_CACHE_HOME="$capture_real/cache" \
  XDG_CONFIG_HOME="$capture_real/config" \
  XDG_DATA_HOME="$capture_real/data" \
  TMPDIR="$capture_real/tmp" \
  TERMINAL_ENV=local \
  TERMINAL_CWD="$workspace_real" \
  TERMINAL_LOCAL_PERSISTENT=false \
  TERMINAL_MAX_FOREGROUND_TIMEOUT=180 \
  HERMES_MAX_ITERATIONS="${HOWA_MAX_TURNS:-24}" \
  HERMES_MAX_TOKENS="${HOWA_MAX_OUTPUT_TOKENS:-8192}" \
  "${provider_env[@]}" \
  "$runtime_executable" "$@"
