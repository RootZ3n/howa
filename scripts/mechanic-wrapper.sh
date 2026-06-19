#!/usr/bin/env bash
#
# Howa the Mechanic wrapper.
#
# Bridges the `<bin> submit <prompt>` shape that Howa's adapter expects
# onto the Mechanic's HTTP API so a Howa trial measures a real the Mechanic task — not
# the milliseconds it took to POST /api/tasks.
#
#   1. POST /api/tasks  {input, repo}      → grab taskId
#   2. Poll GET /api/tasks/:id             → wait for kind=receipt
#   3. Print receipt.result.summary        → Howa's finalAnswer
#
# Env vars:
#   MECHANIC_URL                          (default http://127.0.0.1:18810)
#   MECHANIC_API_TOKEN                    (sent as `Authorization: Bearer …` when set)
#   MECHANIC_WRAPPER_TIMEOUT_SECONDS      (default 120)
#   MECHANIC_WRAPPER_POLL_INTERVAL        (default 1, seconds between polls)
#
# Exit codes:
#   0    the Mechanic returned a receipt — success, partial, escalated, or failed.
#        The wrapper does not editorialize; receipt.status is printed and
#        Howa scores the actual answer.
#   2    Misuse (e.g. `submit` with no prompt, unknown verb).
#   124  Wrapper timeout exceeded before receipt arrived.
#   1    Anything else (network error, malformed JSON, missing jq/curl).

set -euo pipefail

MECHANIC_URL="${MECHANIC_URL:-http://127.0.0.1:18810}"
MECHANIC_WRAPPER_TIMEOUT_SECONDS="${MECHANIC_WRAPPER_TIMEOUT_SECONDS:-120}"
MECHANIC_WRAPPER_POLL_INTERVAL="${MECHANIC_WRAPPER_POLL_INTERVAL:-1}"
TOKEN="${MECHANIC_API_TOKEN:-}"

usage() {
  echo "Usage: mechanic <command> [args]"
  echo "Commands: submit, status, health"
}

require_tools() {
  for tool in curl jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "mechanic: missing required tool '$tool' — install it and retry" >&2
      exit 1
    fi
  done
}

auth_args=()
if [[ -n "$TOKEN" ]]; then
  auth_args+=(-H "Authorization: Bearer $TOKEN")
fi

curl_get() {
  local path="$1" max_time="${2:-15}"
  curl -fsS --max-time "$max_time" "${auth_args[@]}" "$MECHANIC_URL$path"
}

curl_post_json() {
  local path="$1" body="$2" max_time="${3:-30}"
  curl -fsS --max-time "$max_time" "${auth_args[@]}" \
    -X POST -H 'content-type: application/json' \
    --data "$body" \
    "$MECHANIC_URL$path"
}

cmd_health() {
  # the Mechanic's /api/health runs binary smoke checks for every registered
  # adapter (opencode resolution, codex auth probe, …) so it routinely
  # takes ~10 s on a cold service. Give it room.
  if ! body=$(curl_get /api/health 30); then
    echo "mechanic health: GET $MECHANIC_URL/api/health failed" >&2
    return 1
  fi
  # First line is a `status: …` summary so Howa's health probe gets a
  # short, scrapable signal (it only reads the first line). The full JSON
  # follows so a human running `mechanic health` sees the detail.
  local status
  status=$(printf '%s' "$body" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")
  printf 'status: %s\n' "$status"
  printf '%s\n' "$body"
}

cmd_status() {
  if ! body=$(curl_get /api/active-task 10); then
    echo "mechanic status: GET $MECHANIC_URL/api/active-task failed" >&2
    return 1
  fi
  printf '%s\n' "$body"
}

# Render a receipt response as plain text suitable for Howa's
# finalAnswer extraction (last 2 KB of stdout). Reads JSON from stdin.
render_receipt() {
  jq -r '
    .receipt as $r |
    [
      "the Mechanic task " + ($r.taskId // "?") + " — receipt status: " + ($r.status // "?"),
      ($r.result.summary // "" | tostring),
      (if ($r.result.confidence // "") != ""
        then "Verification confidence: " + ($r.result.confidence | tostring)
        else empty end),
      (if ($r.result.failureClass // "") != ""
        then "Failure class: " + ($r.result.failureClass | tostring)
        else empty end),
      (if (($r.result.failureReasons // []) | length) > 0
        then "Failure reasons:\n" + (
          ($r.result.failureReasons | map("- " + (. | tostring)) | join("\n")))
        else empty end),
      (if (($r.plan.steps // []) | length) > 0
        then "Steps:\n" + (
          $r.plan.steps
          | map("- [" + (.status // "?") + "] " + (.title // "")
                + (if (.blockedReason // "") != ""
                    then " — blocked: " + (.blockedReason | tostring)
                    else "" end))
          | join("\n"))
        else empty end)
    ] | map(select(. != null and . != "")) | join("\n\n")
  '
}

cmd_submit() {
  if [[ $# -lt 1 ]]; then
    echo "mechanic submit: missing prompt" >&2
    return 2
  fi
  local prompt="$*"

  local body resp task_id
  body=$(jq -nc --arg input "$prompt" '{input:$input, repo:null}')
  if ! resp=$(curl_post_json /api/tasks "$body" 30); then
    echo "mechanic submit: POST $MECHANIC_URL/api/tasks failed" >&2
    return 1
  fi
  if ! task_id=$(printf '%s' "$resp" | jq -r '.taskId // empty') \
      || [[ -z "$task_id" ]]; then
    echo "mechanic submit: no taskId in response: $resp" >&2
    return 1
  fi

  local start_ts deadline
  start_ts=$(date +%s)
  deadline=$(( start_ts + MECHANIC_WRAPPER_TIMEOUT_SECONDS ))

  local last_kind=""
  local last_state=""
  local last_pending_reason=""

  while :; do
    if (( $(date +%s) >= deadline )); then
      local msg="the Mechanic task $task_id did not produce a receipt within ${MECHANIC_WRAPPER_TIMEOUT_SECONDS}s — last kind=$last_kind, state=$last_state${last_pending_reason:+, pendingApproval=$last_pending_reason}"
      # Mirror the message to BOTH streams so callers that capture only
      # stdout (Howa's generic-cli scrapes finalAnswer from stdout)
      # still see an honest "the task did not finish" signal — and so
      # Howa's truthfulness pack can score the disclosure rather
      # than treating an empty stdout as `no_output`.
      printf '%s\n' "$msg"
      printf 'mechanic submit: %s\n' "$msg" >&2
      curl -fsS --max-time 5 "${auth_args[@]}" \
        -X POST -H 'content-type: application/json' \
        --data '{}' "$MECHANIC_URL/api/tasks/$task_id/cancel" >/dev/null 2>&1 || true
      return 124
    fi

    local poll
    if ! poll=$(curl_get "/api/tasks/$task_id" 15); then
      sleep "$MECHANIC_WRAPPER_POLL_INTERVAL"
      continue
    fi

    last_kind=$(printf '%s' "$poll" | jq -r '.kind // empty' 2>/dev/null || true)
    last_state=$(printf '%s' "$poll" \
      | jq -r '.task.state // .queue.status // empty' 2>/dev/null || true)
    last_pending_reason=$(printf '%s' "$poll" \
      | jq -r '.pendingApproval.summary // .pendingApproval.command // empty' 2>/dev/null || true)

    case "$last_kind" in
      receipt)
        printf '%s' "$poll" | render_receipt
        printf '\n'
        return 0
        ;;
      ""|queued|live)
        sleep "$MECHANIC_WRAPPER_POLL_INTERVAL"
        ;;
      *)
        sleep "$MECHANIC_WRAPPER_POLL_INTERVAL"
        ;;
    esac
  done
}

case "${1:-}" in
  ""|-h|--help|help)
    usage
    ;;
  submit)
    require_tools
    shift
    cmd_submit "$@"
    ;;
  status)
    require_tools
    cmd_status
    ;;
  health)
    require_tools
    cmd_health
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
