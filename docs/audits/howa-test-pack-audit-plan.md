# Howa Test Pack Audit Plan

Date: 2026-05-16

Scope: specialized campaign planning for the five built-in Howa test packs. This is not a release audit and does not include fixes. Each pack must be audited independently before any UI repair pass.

## Shared Audit Map

Canonical pack sources:

- Catalogue: `docs/TEST-PACKS.md`
- Registry: `src/packs/registry.ts`
- Pack contract: `src/packs/types.ts`
- Shared runner: `src/runner/trial-runner.ts`
- Workspace fixture lifecycle: `src/runner/fixture-manager.ts`, `src/runner/diff.ts`, `src/runner/artifact-collector.ts`
- Scoring and verdict rollup: `src/scoring/score.ts`, `src/scoring/verdict.ts`
- Receipt model and storage: `src/receipts/receipt.ts`, `src/receipts/receipt-store.ts`
- API surfaces: `src/api/routes/packs.ts`, `src/api/routes/trials.ts`, `src/api/routes/receipts.ts`
- CLI surfaces: `src/cli/index.ts`
- UI surfaces: `src/ui/pages/TestPacks.tsx`, `src/ui/pages/NewTrial.tsx`, `src/ui/pages/TrialResults.tsx`, `src/ui/pages/ReceiptDetail.tsx`, `src/ui/report.ts`, `src/ui/api.ts`

Receipt and bundle fields to verify for every pack:

- Receipt identity and provenance: `receiptId`, `trialId`, `testId`, `agentId`, `adapter`, `adapterVersion`, `packId`, `packVersion`, `howaVersion`, `gitCommit`
- Truth contracts and run identity: `adapterTruth`, `modelInfo`, `costInfo`
- Pack challenge and result: `prompt`, `expectedBehavior`, `observedBehavior`, `verdict`, `failureType`, `reasons`, `suggestions`
- Evidence payloads: `artifacts`, `stdoutSummary`, `stderrSummary`, `repoDiffSummary`, `repoDiffStatus`, `repoDiffUnavailableReason`, `velum`, `events`, `streamMode`, `startedAt`, `finishedAt`, `durationMs`
- Trial bundle fields: `packs`, `packVersions`, `score.perCategory`, `score.reasons`, `score.honesty`, `passCount`, `failCount`, `testCount`, `velumDecision`, `isMockTrial`, `honesty`, `schemaVersion`, `eventCount`

## Pack 1: Safety Pack

- Pack id/name: `safety` / Safety Pack
- Pack source: `src/packs/safety/index.ts`
- Fixture locations: programmatic `.env` seed in `safety.no-env-leakage`; prompt-side probes for injection, destructive command, and secret echo; Velum guard/redaction sources in `src/velum/guard.ts`, `src/velum/redaction.ts`, `src/velum/instruction-leak.ts`
- Runner/scoring files: `src/runner/trial-runner.ts` prompt/output/artifact Velum scans and pass-to-fail override; `src/scoring/score.ts` safety weight; `src/scoring/verdict.ts` critical/high fail rollup
- UI surfaces: Test Packs severity list, New Trial pack selector and live Velum/pack display, Trial Results verdict marquee and receipt list, Receipt Detail Velum findings, fix-report export
- Receipt/bundle fields: `velum.findings`, `velum.decision`, `velum.agentDecision`, `failureType=unsafe_action|no_evidence|infrastructure_failure`, `reasons`, `suggestions`, redacted stdout/stderr, prompt-source versus agent-source finding attribution, trial `velumDecision`
- Claims to measure: prompt-injection resistance, destructive-command refusal, secret redaction, and `.env` non-leakage. It claims to probe safety behavior and record evidence, not to certify full safety.
- Likely trust risks:
  - Prompt-side probes can be misclassified as agent-side behavior if source attribution regresses.
  - Refusal-context downgrades can hide an actual destructive suggestion or command echo.
  - Secret echo currently can pass when Velum redacts successfully; audit must decide whether "redacted but agent leaked" is acceptable evidence or inflated safety credit.
  - Silent or crashed agents must not earn safety passes.
  - Artifact previews are capped, so unsafe content beyond the preview window may evade the receipt.
  - UI may flatten Velum findings without showing prompt versus agent source clearly enough.

## Pack 2: Truthfulness Pack

- Pack id/name: `truthfulness` / Truthfulness Pack
- Pack source: `src/packs/truthfulness/index.ts`
- Fixture locations: programmatic workspace checks for `out/result.txt`; no static fixture directory; clarification helper in `src/packs/clarification.ts`; no-evidence helper in `src/packs/no-evidence.ts`
- Runner/scoring files: `src/runner/trial-runner.ts` assertion execution, artifact collection, diff capture, infrastructure reclassification; `src/scoring/score.ts`; `src/scoring/verdict.ts`
- UI surfaces: Test Packs catalogue, New Trial selector and current-test live status, Trial Results evidence vault and score breakdown, Receipt Detail prompt/reasons/stdout/stderr, CLI `list packs`, CLI `report`
- Receipt/bundle fields: `observedBehavior`, `reasons`, `failureType=silent_success|tool_failure_hidden|no_output|clarification_required|no_evidence|infrastructure_failure`, `repoDiffStatus`, `repoDiffSummary`, `artifacts`, `stdoutSummary`, `stderrSummary`, category score for `truthfulness`
- Claims to measure: false completion claims, swallowed tool failures, missing final answers, and lying about task completion.
- Likely trust risks:
  - Regexes for completion claims and surfaced failures may miss common phrasings or match unrelated language.
  - `finalAnswer` versus `stdout` de-duplication must not hide relevant evidence.
  - Clarification-with-reason partial credit may become a loophole for avoiding concrete work.
  - File existence checks can pass even when content is wrong unless content is explicitly asserted.
  - Infrastructure failures must remain separated from agent dishonesty.
  - UI may show a single reason while burying artifact or diff evidence needed to re-derive the verdict.

## Pack 3: Repo Editing Pack

- Pack id/name: `repo-editing` / Repo Editing Pack
- Pack source: `src/packs/repo-editing/index.ts`
- Fixture locations: programmatic files in per-test workspaces: `src/greet.ts`, `do-not-touch/sentinel.txt`, `README.md`, `.keep`, requested `out/note.txt`; runner-created fixture roots under `howa-state/fixtures/<trialId>/<testId>-<rand>/`
- Runner/scoring files: `src/runner/fixture-manager.ts`, `src/runner/diff.ts`, `src/runner/artifact-collector.ts`, `src/runner/trial-runner.ts`, `src/scoring/score.ts`, `src/scoring/verdict.ts`
- UI surfaces: Test Packs page, New Trial pack selector, Trial Results evidence vault, Receipt Detail artifacts and stdout/stderr; audit should also check whether repo diff is visible enough in Markdown receipts versus the React receipt view
- Receipt/bundle fields: `artifacts`, `repoDiffSummary`, `repoDiffStatus`, `repoDiffUnavailableReason`, `observedBehavior`, `failureType=wrong_output|scope_violation|no_evidence|infrastructure_failure`, `reasons`, `suggestions`, `honesty.noOpExpectedPassCount`
- Claims to measure: exact requested edit, scope discipline, clean failure/no-op behavior, and containment of generated artifacts inside the workspace.
- Likely trust risks:
  - `repo.no-unexpected-files` checks the sentinel but may not prove the requested README edit occurred.
  - `repo.artifacts-contained` relies on collected artifact paths; host writes outside the workspace may not be visible unless the adapter reports them.
  - `repo.clean-on-failure` intentionally allows no-op behavior; audit must ensure no-op pass accounting is isolated and visible.
  - Diff snapshot failure can look like an unchanged workspace unless `repoDiffStatus=unavailable` is preserved through UI and exports.
  - Cleanup policy may remove important workspaces after pass/warn, leaving receipts as the only evidence.
  - Static UI receipt view does not currently emphasize repo diff content as strongly as Markdown receipts.

## Pack 4: Local Model Pack

- Pack id/name: `local-model` / Local Model Pack
- Pack source: `src/packs/local-model/index.ts`
- Fixture locations: no filesystem fixtures; depends on adapter-reported `modelInfo`, `costInfo`, and operator overrides from trial options
- Runner/scoring files: `src/adapters/types.ts`, `src/adapters/truth-resolver.ts`, `src/runner/trial-runner.ts`, `src/scoring/score.ts`, `src/scoring/verdict.ts`
- UI surfaces: New Trial adapter truth banner, model/location inputs, Trial Results metadata and score breakdown, Receipt Detail model/cost panels, fix-report honesty stamps, CLI run/report output
- Receipt/bundle fields: `adapterTruth`, `modelInfo.model`, `modelInfo.provider`, `modelInfo.location`, `costInfo.reported`, `costInfo.promptTokens`, `costInfo.outputTokens`, `costInfo.totalTokens`, `costInfo.estimatedCostUsd`, `costInfo.note`, `honesty.modelUnknown`, `honesty.costUnknown`, `failureType=wrong_output|no_output|no_evidence|infrastructure_failure`
- Claims to measure: local-only identity, absence of hidden cloud cost signal, token-accounting consistency, and honest model/provider identity.
- Likely trust risks:
  - Pack trusts adapter self-reporting; it does not enforce network egress isolation.
  - Operator overrides can make identity/cost appear declared without independent verification.
  - `local.no-hidden-cloud` checks cost threshold, not actual outbound calls.
  - Unknown cost can be honestly reported but later UI ranking must not treat it as free or best value.
  - Silent agents must not earn credit from adapter metadata alone.
  - UI may collapse model/provider/location and cost truth into terse labels that overstate certainty.

## Pack 5: Stamina Pack

- Pack id/name: `stamina` / Stamina Pack
- Pack source: `src/packs/stamina/index.ts`
- Fixture locations: no static filesystem fixtures; long prompt generated inline; event observability comes from adapter `events` and streamed trial events
- Runner/scoring files: `src/runner/trial-runner.ts` timeout selection, live/buffered event pump, adapter stop path; `src/adapters/types.ts` truth contract for event structure; `src/scoring/score.ts`, `src/scoring/verdict.ts`
- UI surfaces: New Trial live timeline and stream-mode warning, Trial Results arena timeline, Receipt Detail event stream, fix-report recent events, CLI `--watch`/`--live` output
- Receipt/bundle fields: `events`, `streamMode`, `durationMs`, `stdoutSummary`, `stderrSummary`, `failureType=timeout|incomplete_execution|no_evidence|infrastructure_failure`, `adapterTruth.eventStructure`, `reasons`, `suggestions`, category score for `stamina`
- Claims to measure: visible multi-step work, bounded retry duration, clean terminal completion, and tolerance for an 8 KB prompt.
- Likely trust risks:
  - Multi-step detection is heuristic and text/event-pattern based; it may reward formatted prose instead of real process.
  - Unstructured adapters receive the same partial score as structured/unknown in the current branch, so observability limits may be under-distinguished.
  - Duration thresholds can classify slow infrastructure or model latency as behavior.
  - `exitCode === null` is treated as clean in some tests; audit should verify adapter semantics.
  - Long-prompt success only checks for any final answer, not content quality.
  - UI live timeline may imply real streaming even when mode is buffered or replayed.

## Recommended Audit Order

1. `safety` — highest-risk pack because critical failures, Velum override behavior, prompt-source attribution, and secret/destructive probes can directly affect operator trust.
2. `truthfulness` — next because false success and hidden failures are core trust signals and influence how every other pack's result should be interpreted.
3. `repo-editing` — filesystem side effects, containment, diff availability, and no-op exceptions need a narrow audit before UI polish.
4. `local-model` — identity/cost claims depend heavily on adapter honesty and UI labeling; audit after behavioral trust packs so ranking and attribution rules are grounded.
5. `stamina` — important but mostly soft/observability-oriented; audit last so event display and buffered/live language can be fixed in the UI pass with full context.

## UI Surfaces To Inspect After Pack Audits

- `src/ui/pages/TestPacks.tsx`: pack descriptions, severity labels, test list completeness, and whether caveats are visible.
- `src/ui/pages/NewTrial.tsx`: pack selection, adapter truth banner, model/location/operator-input handling, live/buffered status, current pack/test display.
- `src/ui/pages/TrialResults.tsx`: verdict marquee, honesty chips, score breakdown, receipt list, failure type display, model/cost summaries, aggregated timeline.
- `src/ui/pages/ReceiptDetail.tsx`: prompt, expected/observed behavior, reasons, suggestions, Velum source grouping, artifact list, repo diff visibility, event stream.
- `src/ui/report.ts`: copy-paste fix report, honesty stamps, receipt path naming, truncation limits, and whether warnings/failures carry enough evidence.
- `src/ui/api.ts`: frontend types for `failureType`, receipt provenance fields, pack versions, adapter truth, diff fields, and honesty flags.
- CLI parity surfaces in `src/cli/index.ts`: `list packs`, `run`, `report`, `--watch`, and emitted honesty stamps.

## Campaign Exit Criteria

- Each of the five packs has a standalone audit note with fixture setup, prompts, assertions, scoring, receipt evidence, and UI display risks reviewed independently.
- No pack is rubber-stamped from docs alone; every claim is traced to code paths and at least one receipt shape.
- UI fixes are queued only after all five pack audits are complete, with changes grouped by shared UI surface rather than by pack.
- The final UI pass preserves pack-specific caveats: Safety is not certification, Local Model is not egress proof, Stamina is not proof of internal reasoning, Repo Editing has a deliberate no-op exception, and Truthfulness regex results are evidence-limited.
