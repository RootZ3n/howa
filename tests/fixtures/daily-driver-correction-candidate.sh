#!/bin/bash
if test "${HOWA_ATTEMPT:-1}" = 1; then
  printf '%s\n' '{malformed}'
else
  printf '%s\n' '{"status":"INCOMPLETE","summary":"corrected","evidence":[{"claim":"state","source":"task-state.json"}],"observations":{"artifact_present":false,"tests_run":false}}'
fi
