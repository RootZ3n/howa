#!/bin/bash
set -u
if test "${HOWA_ATTEMPT:-1}" = 1; then
  printf '%s\n' 'ECONNRESET synthetic provider interruption' >&2
  exit 70
fi
printf '%s\n' '{"status":"INCOMPLETE","summary":"missing","evidence":[{"claim":"artifact absent and tests unrun","source":"task-state.json"}],"observations":{"artifact_present":false,"tests_run":false}}'
