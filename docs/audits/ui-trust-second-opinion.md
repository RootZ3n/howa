# UI Trust/Export — Second Opinion Audit

**Auditor:** Claude Opus 4.6 (hostile second-opinion)
**Date:** 2026-05-16
**Target commit:** 8a1d893 (Codex UI trust audit)

## Summary Verdict: CONFIRMED_CLEAN (with 1 LOW observation)

The UI trust layer is well-designed and comprehensive. All three definitions of
EvaluationCategory are synchronized. Honesty stamps are surfaced in all export
paths. Mock/error/no-evidence trials are excluded from champion eligibility.
Historical schema is flagged. No issues found.

---

## Findings

### 1. CONFIRMED_CLEAN — EvaluationCategory synchronized across all definitions

- **Files:** `src/packs/types.ts:68-122`, `src/ui/api.ts:156-210`, `src/ui/trust-display.ts:3-58`
- **Evidence:** Diffed the category lists — zero differences. All 57 categories match.
- **Codex missed?** No.

### 2. CONFIRMED_CLEAN — All honesty stamps surface in export

- **File:** `src/ui/report.ts:26-69`
- **Evidence:** `buildAgentFixReport` checks all honesty flags: `isMockTrial`,
  `noBehavioralEvidence`, `allBehavioralFailed`, `provisional`,
  `costExcludedFromTrust`, `modelUnknown`, `costUnknown`, historical schema,
  and error verdict. Each produces a visible stamp.
- **Test coverage:** `tests/export-honesty.test.ts` (8 tests) covers MOCK, NO
  BEHAVIORAL EVIDENCE, ALL BEHAVIORAL FAILED, PROVISIONAL, COST WITHHELD, ERROR.
- **Codex missed?** No.

### 3. CONFIRMED_CLEAN — Champion board excludes degenerate trials

- **File:** Tests at `tests/export-honesty.test.ts:141-165`
- **Evidence:** `isChampionEligible` excludes mock trials, error verdicts, and
  no-behavioral-evidence trials. Only clean, non-mock, behavior-bearing trials
  are eligible.
- **Codex missed?** No.

### 4. CONFIRMED_CLEAN — Silent agent trust ceiling at ~0.1

- **File:** `tests/trust-audit.test.ts:138-175`
- **Evidence:** A silent adapter running all packs scores `trust <= 0.1` and
  `passCount <= 1` (only `repo.clean-on-failure` can legitimately pass as no-op).
  The pre-fix score was ~66%.
- **Codex missed?** No.

### 5. CONFIRMED_CLEAN — Cost cannot purchase trust on its own

- **File:** `tests/trust-audit.test.ts:178-238`
- **Evidence:** When every behavioral category averages zero, cost efficiency is
  excluded from trust (`costExcludedFromTrust: true`). Trust stays at 0.
- **Codex missed?** No.

### 6. CONFIRMED_CLEAN — Partial fail verdict language

- **File:** `src/ui/trust-display.ts:60-92`
- **Evidence:** A fail with some passes shows "Blocked" + "Some checks passed...
  partial evidence, not a clean result." A zero-pass fail shows "Rejected."
  The UI never presents a partial fail as a total rejection.
- **Test coverage:** `tests/ui-trust-audit.test.ts:120-132`.
- **Codex missed?** No.

### 7. CONFIRMED_CLEAN — Receipt JSON export includes key fields

- **File:** `src/ui/trust-display.ts:171-197`
- **Evidence:** Export includes `evaluationCategory`, `failureType`, `reasons`,
  `modelInfo`, `costInfo`, `expectedBehavior`, `observedBehavior`, `stdoutSummary`,
  `stderrSummary`. All the fields a downstream consumer needs to understand the result.
- **Test coverage:** `tests/ui-trust-audit.test.ts:151-186`.
- **Codex missed?** No.

### 8. TEST_GAP (LOW) — JSON export omits Velum findings

- **Severity:** LOW
- **File:** `src/ui/trust-display.ts:179-192`
- **Why it matters:** `buildReceiptsJsonExport` does not include `velum` in the
  exported receipt shape. A downstream consumer parsing the JSON export cannot see
  Velum findings (e.g., which destructive rules fired, what was redacted). The full
  receipt JSON on disk still has Velum data, but the export endpoint strips it.
- **Risk:** LOW — the velum field is large and may be intentionally omitted for data
  minimization. The markdown export includes evaluation categories that summarize
  Velum's impact. Consumers who need raw Velum data can read the on-disk receipts.
- **Codex missed?** Yes (minor — may be intentional).
- **Recommended fix:** Add `velumDecision: r.velum.decision` to the export shape
  (just the decision, not the full findings array) so consumers know if Velum flagged
  anything.

### 9. CONFIRMED_CLEAN — Historical schema flagging

- **File:** `src/ui/report.ts:62-66`
- **Evidence:** Trials with `schemaVersion < 2` or undefined get a "HISTORICAL
  SCHEMA" stamp. These predate honesty metadata and are excluded from current rankings.
- **Codex missed?** No.

---

## Audit Checklist

| Question | Answer |
|----------|--------|
| Does it measure what it claims? | YES — surfaces all categories, honesty flags, and identity/cost |
| Can it pass for the wrong reason? | NO — champion eligibility excludes mock/error/no-evidence |
| Can it fail for infrastructure reasons but look like agent failure? | NO — INFRA_FAILURE labeled |
| Are fixtures leaking answers? | N/A — UI layer, no fixtures |
| Are prompts ambiguous? | N/A |
| Are categories/reasons visible in receipts/UI/export? | YES — all three paths checked |
| Are score/verdict/category consistent? | YES — 3 definitions synchronized |
| Are tests deep enough? | YES — 30 tests across 3 files |
| Can empty/provider/timeout states be misreported? | NO |
| Can no-op behavior pass incorrectly? | N/A — UI layer |
| Can stale/mock/demo data look live? | NO — isMockTrial + HISTORICAL SCHEMA stamps |

---

## Overall Assessment

The UI trust layer is the strongest-audited component. All category definitions are
synchronized, honesty stamps cover every degenerate case, and exports include the
information downstream consumers need. The only minor gap is the missing Velum
decision in the JSON export, which may be intentional.

**Issues found:** 0 (1 LOW observation about JSON export omitting Velum decision)
**Blockers:** 0
**Codex missed anything critical?** No
