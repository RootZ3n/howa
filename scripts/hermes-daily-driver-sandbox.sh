#!/bin/bash
set -euo pipefail

workspace="${HOWA_DAILY_DRIVER_WORKSPACE:?Howa must provide HOWA_DAILY_DRIVER_WORKSPACE}"
session_root="${HERMES_HOME:?Howa must provide an isolated HERMES_HOME}"
workspace_real="$(realpath -- "$workspace")"
session_real="$(realpath -- "$session_root")"

case "$workspace_real" in /tmp/howa-ddv1-*/fixture-attempt-*) ;; *) echo "refusing non-Howa workspace: $workspace_real" >&2; exit 78 ;; esac
case "$session_real" in /tmp/howa-ddv1-*/hermes-session-*) ;; *) echo "refusing non-Howa session root: $session_real" >&2; exit 78 ;; esac

exec bwrap \
  --die-with-parent \
  --new-session \
  --ro-bind / / \
  --proc /proc \
  --dev /dev \
  --tmpfs /pehverse \
  --tmpfs /home/zen/.hermes \
  --ro-bind /home/zen/.hermes/hermes-agent /home/zen/.hermes/hermes-agent \
  --bind "$workspace_real" "$workspace_real" \
  --bind "$session_real" "$session_real" \
  --chdir "$workspace_real" \
  --setenv HERMES_HOME "$session_real" \
  --setenv HOWA_DAILY_DRIVER_WORKSPACE "$workspace_real" \
  /home/zen/.local/bin/hermes "$@"
