#!/bin/bash
set -euo pipefail
usage_file="$1"
mkdir -p "$(dirname "$usage_file")"
sqlite3 "$HERMES_HOME/state.db" <<'SQL'
CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, effect_disposition TEXT, timestamp REAL, token_count INTEGER, finish_reason TEXT, compacted INTEGER);
INSERT INTO messages VALUES (1,'user','inspect task-state.json',NULL,NULL,NULL,NULL,1787418000,5,NULL,0);
INSERT INTO messages VALUES (2,'assistant',NULL,NULL,'[{"id":"call-1","function":{"name":"terminal","arguments":"{\"command\":\"cat task-state.json\"}"}}]',NULL,NULL,1787418001,8,'tool_calls',0);
INSERT INTO messages VALUES (3,'tool','{"exit_code":0,"output":"tests_run=false"}','call-1',NULL,'terminal','read_only',1787418002,4,NULL,0);
SQL
printf '%s\n' '{"estimated_cost_usd":0.01,"input_tokens":17,"output_tokens":9,"model":"offline/mock-v1","provider":"offline"}' > "$usage_file"
printf '%s\n' '{"status":"INCOMPLETE","summary":"trusted transcript fixture","evidence":[{"claim":"artifact absent and tests not run","source":"task-state.json"}],"observations":{"artifact_present":false,"tests_run":false},"served_model_identity":"offline/mock-v1"}'
