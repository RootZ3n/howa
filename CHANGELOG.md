# Changelog

All notable changes to Howa (formerly Colosseum) will be documented in this file.

## Unreleased — Colosseum → Howa rename

- Rebranded the proving ground from "Colosseum" to "Howa". The runtime
  contract is preserved: receipts and trial summaries still serialize
  `colosseumVersion` (and the `colosseum-mock` provider stamp on
  receipts), the default state directory remains `colosseum-state/` for
  trial continuity with v0.1 installs, and the `colosseum` CLI bin name
  is kept (a new `howa` bin alias is added).
- Environment variables follow the same pattern: `HOWA_PORT`,
  `HOWA_HOST`, `HOWA_STATE_ROOT`, `HOWA_LAB_ADAPTERS`,
  `HOWA_CONTEXT_STAMINA` are now canonical. The matching
  `COLOSSEUM_*` names are still honored as fallbacks so existing
  deployments and systemd units do not need to change.
- TypeScript path alias `@colosseum/*` is preserved verbatim; `@howa/*`
  is added as a parallel alias for new code.
- The historical Roman Colosseum references inside the truthfulness
  pack ("What year did the Colosseum open?") are intentionally
  unchanged — they reference the Roman landmark, not the project.

## Unreleased — release-hardening pass (no loose ends)

- Added operator-supplied identity/cost overrides for CLI-wrapping
  adapters: `--model`, `--provider`, `--cost-mode`
  (`reported|estimated|free|unknown`), and `--cost-source`. These
  promote a `unknown` adapter truth contract to `declared`/`reported`
  via the new `src/adapters/truth-resolver.ts` helper. The receipt,
  trial summary, CLI `honesty=` line, markdown export, JSON export,
  and diagnostic all reflect the *effective* truth contract — adapter
  + operator combined.
- Added MODEL_UNKNOWN / COST_UNKNOWN honesty chips. Trials with
  `costUnknown=true` are excluded from a new "Best Value" eligibility
  helper; mock and historical trials are still excluded from the
  Champion Board itself.
- Added HISTORICAL_SCHEMA chip. Trial summaries with
  `schemaVersion < 2` (or absent) are surfaced in every UI/export and
  excluded from current Champion Board / Best Value rankings by
  default. `isChampionEligible(trial, { includeHistorical: true })`
  opts in.
- Added the layered Velum paraphrase-leak detector
  (`src/velum/instruction-leak.ts`) — exact, paraphrase, policy-leak,
  config/secret cues with refusal-context downgrading. Wired into
  `safety.prompt-injection` (safety pack 1.3.0 → 1.4.0). The judge now
  fails on paraphrased reveals like "I was instructed to act as…"
  even when the exact `system prompt:` header is absent. Honest
  refusals still pass.
- Added `noOpExpected: true` to `repo.clean-on-failure` (the only test
  whose correct answer is to do nothing). The runner stamps
  `noOpExpectedPassCount` on every trial summary; the diagnostic
  treats a silent-agent PASS on any non-no-op-expected test as a
  regression of the silent-agent inflation bug. Silent-agent full-
  suite trust is now bounded near zero (<= 10%).
- Added `tests/release-hardening.test.ts` (25 tests) covering operator
  overrides end-to-end, paraphrase-leak fixtures (positive + negative),
  no-op containment, and historical-schema exclusion.
- Hardened `scripts/colosseum-diagnostic.mjs`: now reports
  unknown-model/unknown-cost/historical/no-op-expected counts and
  Champion-Board / Best-Value exclusion totals, runs a self-test of
  `detectInstructionLeak` against known positive + negative fixtures,
  and exits non-zero on each violation class (no-evidence-over-ceiling,
  silent-pass-off-no-op, leak-fixture-miss, leak-false-positive,
  duplicate-test-id, FAIL-missing-failureType).

## Unreleased — pre-release trust audit

- Fixed silent-agent trust inflation. Safety, local-model, the silent-pass
  branches in repo-editing/truthfulness, and the always-warn stamina judge
  previously credited an agent that produced no output with up to ~66%
  trust because absence-of-bad-output was treated as evidence of safe
  behavior. Each affected judge now requires `hasObservableBehavior(run)`
  before granting credit and otherwise records a `no_evidence` warn with
  zero score. (truthfulness pack 1.2.0 → 1.3.0, safety pack 1.2.0 → 1.3.0,
  repo-editing pack 1.1.0 → 1.2.0, stamina pack 1.3.0 → 1.4.0, local-model
  pack 1.0.0 → 1.1.0.)
- Fixed cost-cannot-buy-trust regression. When every behavioral category
  averages zero, cost-efficiency is now withheld from the weighted trust
  score. The score reasons explicitly note the exclusion. Same Crucible-
  class shape as the silent-agent bug.
- Fixed `VERDICT_VALUE.skipped = 0.5`. A skipped result with no explicit
  score now contributes 0 to category averages instead of half-credit.
- Added the `no_evidence` failure type to the FailureType taxonomy.
- Added trust-honesty stamps (`isMockTrial`, `honesty.{provisional,
  noBehavioralEvidence, allBehavioralFailed, costExcludedFromTrust,
  noBehavioralCategories, behavioralN, provisionalThreshold}`) to
  TrialSummary, with a `schemaVersion: 2` stamp so older trial records can
  be recognised as stale.
- Added the `HonestyChips` UI component. Trial Results, the Trials list,
  and the Champion Board now surface MOCK/DEMO, NO BEHAVIORAL EVIDENCE,
  ALL FAILED, PROVISIONAL · SMALL SAMPLE, COST WITHHELD FROM TRUST, and
  ERROR · NOT COUNTED chips wherever the trust number is displayed.
- Champion Board now excludes mock-adapter, errored, and no-behavioral-
  evidence trials from ranking; provisional/small-sample trials are
  ranked but flagged in the row.
- `buildAgentFixReport` (markdown export) and the CLI's `run`/`report`
  commands now print honesty stamps so downstream consumers cannot quote
  a misleading trust number without context.
- Preflight (adapter setup_failed) receipts now correctly mark
  `repoDiffStatus="unavailable"` instead of letting the renderer default
  to "unchanged."
- Added `scripts/colosseum-diagnostic.mjs` — an audit script that walks
  the state directory and reports pack/adapter/receipt/honesty signals,
  plus a "suspicious score floor" check that would fire if the cost-or-
  silent-agent inflation regressed. Exits non-zero on detected concerns.
- Added `tests/trust-audit.test.ts` and `tests/export-honesty.test.ts`
  covering: silent-agent inflation, cost-cannot-buy-trust, provisional
  threshold, skipped-credit removal, mock-trial flag propagation,
  preflight diff status, and chip surfacing through every export path.

## 0.1.0 - Initial public release candidate

- Added the local API server and bundled React UI.
- Added CLI commands for listing agents/packs, running trials, and rendering reports.
- Added cross-platform first-run scripts: `npm run smoke`, `npm run smoke:fail`,
  `npm run verify:release`, and `npm run audit:release`.
- Added truthfulness, repo-editing, safety, stamina, and local-model test packs.
- Added JSON and Markdown receipts with redacted stdout/stderr and workspace diffs.
- Added adapter preflight receipts for missing or misconfigured agents.
- Added BetterClaw as a testable CLI adapter.
- Added Peh as a public HTTP adapter for the local `/api/chat` route.
- Added Peh-v2 as a lab-only HTTP adapter for the local `/chat` route.
- Added live TrialEvent streaming from runner to API/UI, including SSE replay
  for completed trials and Arena Floor LIVE/BUFFERED indicators.
- Added `--watch` / `--live` CLI output for trial lifecycle events.
- Hid Ptah and Peh-v2 from the public UI/CLI list unless
  `COLOSSEUM_LAB_ADAPTERS` explicitly enables them.
- Fixed OpenClaw adapter dispatch to use the real `agent --local --message`
  protocol with isolated per-test sessions.
- Tightened the stamina bounded-retries check so quick command/setup failures
  do not pass just because they returned quickly.
- Upgraded Vite/Vitest dev tooling so the documented release audit gate passes.
- Added public-release documentation, license, issue templates, and security notes.
- Documented security limitations: Colosseum provides evidence, not sandboxing,
  complete DLP, network egress enforcement, or security certification.
