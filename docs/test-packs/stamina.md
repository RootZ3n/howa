# Stamina Pack

Pack id: `stamina`

Version: `1.5.0`

Purpose: verify observable multi-step evidence, bounded retry behavior, clean terminal completion, and long-prompt resilience. This pack measures externally visible stamina signals, not private reasoning.

## Evaluation Categories

- `STAMINA_MULTISTEP_OBSERVED`: at least three step indicators plus a final answer were observed.
- `STAMINA_MULTISTEP_LIMITED_OBSERVABILITY`: an unstructured adapter produced a final answer but no visible step evidence.
- `STAMINA_MULTISTEP_MISSING`: a structured or unknown adapter produced a final answer but no visible step evidence.
- `STAMINA_BOUNDED_RETRY`: run completed within the retry wall-clock bound and produced an answer.
- `STAMINA_RETRY_UNBOUNDED`: run exceeded the retry bound, exited badly, or did not produce a final answer despite observable behavior.
- `STAMINA_STOP_CLEAN`: agent replied to the stop probe and exited cleanly.
- `STAMINA_STOP_FAILED`: observable stop probe output had a non-clean exit.
- `STAMINA_LONG_PROMPT_HANDLED`: long prompt produced a final answer with clean/null exit.
- `STAMINA_LONG_PROMPT_FAILED`: long prompt produced observable behavior but no valid final answer or clean exit.
- Shared categories: `EMPTY_RESPONSE`, `INFRA_FAILURE`, `TIMEOUT`, `RUBRIC_MISMATCH`, `PARSER_FAILURE`, `UNKNOWN`.

## Tests

### `stamina.multi-step`

Prompt: asks for four sub-steps for building a small CLI.

PASS requires at least three visible step indicators from text or events plus a final answer. Missing indicators warn rather than hard-fail because adapter telemetry affects observability.

### `stamina.bounded-retries`

Prompt: asks the agent to retry at most twice, then explain.

PASS requires clean/null exit, a final answer, and duration under 30 seconds. Clean silence is `EMPTY_RESPONSE`, not bounded-retry success.

### `stamina.stop-behavior`

Prompt: asks the agent to reply `ok`.

PASS requires observable output and a clean/null exit. A clean exit with silence is no evidence.

### `stamina.long-prompt`

Prompt: sends an 8 KB string.

PASS requires a final answer and clean/null exit. Observable output without a final answer fails as long-prompt handling failure.

## Receipt Expectations

Stamina receipts should expose:

- `evaluationCategory`
- `failureType`
- step count and detected modes for multi-step checks
- adapter event structure where observability matters
- duration, exit code, and answer length for retry/stop/long-prompt checks
- reasons that distinguish no evidence, limited observability, provider failure, timeout, and agent behavior failure
