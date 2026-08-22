#!/bin/bash
set -euo pipefail
printf '%s\n' 'API_KEY=supersecretvalue'
printf '%s\n' '{"status":"INCOMPLETE","summary":"credential appeared","evidence":[{"claim":"artifact absent","source":"task-state.json"}],"observations":{"artifact_present":false,"tests_run":false},"served_model_identity":"offline/mock-v1"}'
