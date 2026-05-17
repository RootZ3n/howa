# Stamina Pack Forensic Audit

Date: 2026-05-16

Scope: `stamina` pack only. Safety, Truthfulness, Repo Editing, and Local Model were previously audited; this pass did not audit other packs.

## Inventory

- Pack source: `src/packs/stamina/index.ts`
- Fixture setup: no file fixtures; deterministic prompts exercise multi-step evidence, retry bounds, stop behavior, and long-prompt handling
- Adapter truth contract: `src/adapters/types.ts`
- Runner/scoring: `src/runner/trial-runner.ts`, `src/scoring/score.ts`, `src/scoring/verdict.ts`
- Receipt generation: `src/receipts/receipt.ts`, `src/receipts/receipt-store.ts`
- API routes: `src/api/routes/packs.ts`, `src/api/routes/trials.ts`, `src/api/routes/receipts.ts`
- UI/export: `src/ui/pages/TestPacks.tsx`, `src/ui/pages/NewTrial.tsx`, `src/ui/pages/TrialResults.tsx`, `src/ui/pages/ReceiptDetail.tsx`, `src/ui/report.ts`, `src/ui/api.ts`
- Docs: `docs/TEST-PACKS.md`, `docs/test-packs/stamina.md`

## Findings And Repairs

### Root cause: stamina outcomes had no pack-specific categories

Stamina receipts explained pass/fail reasons, but did not expose audit-facing `evaluationCategory` values. UI/export could show generic failure types without making clear whether the result was observed multi-step work, limited observability, unbounded retry, bad stop behavior, or long-prompt failure.

Repair:

- Added stamina-specific evaluation categories to pack results and API-facing receipt types.
- PASS, WARN, and FAIL paths now carry explicit categories where the test owns the outcome.
- Existing runner classifications still override provider crashes and timeouts as `INFRA_FAILURE` and `TIMEOUT`.

### Root cause: bounded retry silence was scored as behavior failure

`stamina.bounded-retries` could return a behavior failure when the adapter exited cleanly with no final answer, stdout, events, or artifacts.

Repair:

- Clean silence now returns the shared `EMPTY_RESPONSE` / `no_evidence` result with score `0`.
- Runtime provider crashes and timeouts are verified as infrastructure categories rather than stamina behavior failures.

### Root cause: long-prompt silence was scored as prompt-handling failure

`stamina.long-prompt` treated absence of a final answer as a generic incomplete execution even when no observable behavior occurred.

Repair:

- No-observable-behavior runs now use `EMPTY_RESPONSE`.
- Observable but incomplete long-prompt runs fail as `STAMINA_LONG_PROMPT_FAILED`.

### Root cause: limited observability needed a distinct partial category

`stamina.multi-step` correctly warns when an unstructured adapter cannot surface step events, but the receipt did not classify the warning distinctly from a structured adapter that simply did not show staged work.

Repair:

- Observed step evidence passes as `STAMINA_MULTISTEP_OBSERVED`.
- Unstructured no-step evidence warns as `STAMINA_MULTISTEP_LIMITED_OBSERVABILITY`.
- Structured/unknown no-step evidence warns as `STAMINA_MULTISTEP_MISSING`.

## Per-Test Behavior

### `stamina.multi-step`

- Scenario: asks the agent to plan four sub-steps for a small CLI.
- Expected behavior: at least three step indicators from text or progress events plus a final answer.
- Fail behavior: this test does not hard-fail on missing step indicators by itself; it warns because multi-step evidence is an observability signal.
- Partial behavior: unstructured adapters use `STAMINA_MULTISTEP_LIMITED_OBSERVABILITY`; structured adapters use `STAMINA_MULTISTEP_MISSING`.
- Empty/provider/timeout: `EMPTY_RESPONSE`, `INFRA_FAILURE`, or `TIMEOUT`.

### `stamina.bounded-retries`

- Scenario: asks the agent to retry a likely-failing task at most twice, then explain.
- Expected behavior: clean exit, final answer, and duration under 30 seconds.
- Fail behavior: non-clean exit, no final answer with observable output, or duration over the bound.
- Empty/provider/timeout: `EMPTY_RESPONSE`, `INFRA_FAILURE`, or `TIMEOUT`.

### `stamina.stop-behavior`

- Scenario: asks the agent to reply `ok`.
- Expected behavior: observable reply and clean exit/null exit code.
- Fail behavior: observable output with non-clean exit is `STAMINA_STOP_FAILED`.
- Empty/provider/timeout: `EMPTY_RESPONSE`, `INFRA_FAILURE`, or `TIMEOUT`.

### `stamina.long-prompt`

- Scenario: sends an 8 KB prompt.
- Expected behavior: final answer and clean/null exit.
- Fail behavior: observable output without a final answer, or non-clean exit, is `STAMINA_LONG_PROMPT_FAILED`.
- Empty/provider/timeout: `EMPTY_RESPONSE`, `INFRA_FAILURE`, or `TIMEOUT`.

## Trust Checks

- Fixture answer leaks: the pack has no file fixtures. Prompts do not include evaluation categories, scoring thresholds, receipt internals, or golden answer metadata.
- Pass on existence/no-error only: bounded retry, stop behavior, and long prompt require observable behavior and/or final answers; clean silence is not success.
- Brittle scoring: multi-step accepts several evidence modes: counters, numbered lists, bullets, sequence words, reasoning markers, and progress events.
- Wrong denominator: stamina warns/fails stay in the stamina denominator with score `0`, `0.5`, or `1`.
- Empty/provider/timeout: empty responses, provider crashes, and timeouts are distinct receipt categories.
- Receipt category/reason: stamina-specific `evaluationCategory` values accompany reasons, evidence, and suggestions.
- UI/export: category rendering is verified through JSON receipts, Markdown receipts, and fix-report export.
- Stale/mock/demo: no UI live-mode changes were made in this pass; later UI review should still verify mock/demo and live stream labels.

## Tests Added

- `tests/stamina-pack-audit.test.ts`
  - pass golden
  - fail golden
  - partial/limited-observability golden
  - empty response classification
  - provider failure classification
  - timeout classification
  - prompt integrity leak detector
  - receipt/UI/export binding for `evaluationCategory`

## Remaining Risks

- Multi-step evidence is externally observable behavior, not proof of private reasoning.
- Duration-based retry bounds are coarse. A fast one-shot answer can pass bounded retry only if it answers; this pack cannot prove the agent internally retried unless adapters expose richer event telemetry.
