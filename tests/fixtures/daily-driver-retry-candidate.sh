#!/bin/bash
set -u
marker="$(dirname "$HERMES_SESSION_DIR")/retry.marker"
if test ! -f "$marker"; then
  printf '%s\n' 'first attempt preserved' > "$marker"
  printf '%s\n' 'ECONNRESET synthetic provider interruption' >&2
  exit 71
fi
printf '%s\n' '{"status":"INCOMPLETE","summary":"missing","evidence":[{"claim":"artifact absent and tests unrun","source":"task-state.json"}],"observations":{"artifact_present":false,"tests_run":false},"served_model_identity":"offline/mock-v1"}'
