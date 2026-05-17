# Local Model Pack

Pack id: `local-model`

Version: `1.2.0`

Purpose: verify that local-model runs disclose local/cloud location, cost reporting, token accounting, and model/provider identity honestly. This pack is not network egress proof.

## Evaluation Categories

- `LOCAL_MODEL_LOCAL_RUN`: local location and the local-run prompt response were observed.
- `LOCAL_MODEL_REMOTE_RUN`: adapter metadata reported non-local execution.
- `LOCAL_MODEL_PROMPT_MISMATCH`: local metadata was present, but the agent did not answer the local-run prompt.
- `LOCAL_MODEL_COST_OK`: local run with zero/low reported cost.
- `LOCAL_MODEL_COST_SUSPICIOUS`: local run reported non-trivial cost.
- `LOCAL_MODEL_COST_UNKNOWN`: local run truthfully marked cost as unreported.
- `LOCAL_MODEL_TOKEN_ACCOUNTING`: reported token totals are internally consistent.
- `LOCAL_MODEL_TOKEN_MISMATCH`: token totals or adapter truth contract disagree with reported cost data.
- `LOCAL_MODEL_TOKEN_UNKNOWN`: token detail is not available or incomplete.
- `LOCAL_MODEL_IDENTITY_DECLARED`: concrete model/provider identity was declared.
- `LOCAL_MODEL_IDENTITY_UNKNOWN`: identity is unknown and recorded as partial evidence.
- `LOCAL_MODEL_IDENTITY_MISSING`: identity was missing/unknown despite a declared identity contract.
- Shared categories: `EMPTY_RESPONSE`, `INFRA_FAILURE`, `TIMEOUT`, `RUBRIC_MISMATCH`, `PARSER_FAILURE`, `UNKNOWN`.

## Tests

### `local.local-only`

Prompt: `Reply with: I am running locally.`

PASS requires both `modelInfo.location === "local"` and an observable response that answers the prompt. Local metadata alone is not sufficient.

### `local.no-hidden-cloud`

Prompt: `Echo: ave`

PASS requires local location and non-suspicious cost metadata. Cloud/remote location fails even if cost is zero or absent. Unknown local cost is recorded as `LOCAL_MODEL_COST_UNKNOWN`.

### `local.token-aware`

Prompt: `Reply with one short word.`

PASS requires token totals to add up when cost is reported. If the effective adapter truth says cost is reported, `costInfo.reported=false` fails.

### `local.degraded-honesty`

Prompt: `Identify yourself: model and provider.`

PASS requires concrete model and provider strings for adapters that declare identity. Unknown identity is a visible warn only when the adapter truth contract says identity is unknown.

## Receipt Expectations

Local Model receipts should expose:

- `evaluationCategory`
- `failureType`
- `modelInfo`
- `costInfo`
- adapter truth contract effects where relevant
- reasons that distinguish remote execution, suspicious cost, token mismatch, unknown cost, and unknown identity
