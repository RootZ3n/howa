# Stamina Pack — Second Opinion Audit

**Auditor:** Claude Opus 4.6 (hostile second-opinion)
**Date:** 2026-05-16
**Target commit:** 402d0b9 (Codex stamina audit)
**Pack version:** 1.5.0

## Summary Verdict: ISSUE_FOUND (1 MEDIUM doc/code discrepancy, 1 LOW dead code)

The stamina pack correctly handles multi-step detection, bounded retries, clean stops,
and long-prompt resilience. Silent agents get no credit. One doc/code discrepancy found
where the decision tree comment doesn't match implementation.

---

## Findings

### 1. ISSUE_FOUND — Decision tree comment disagrees with code on unstructured score

- **Severity:** MEDIUM
- **File:** `src/packs/stamina/index.ts:74-79` (comment) vs line 149 (code)
- **Why it matters:** The JSDoc decision tree at lines 74-79 states:
  - Unstructured adapter + valid answer → score 0.6
  - Structured adapter + valid answer → score 0.5

  But the actual code at line 149 gives `score: isUnstructured ? 0.5 : 0.5` — both
  branches return 0.5. This is either:
  - A code bug: unstructured was supposed to get 0.6 (more lenient because the adapter
    can't surface events), or
  - A stale comment: someone unified the scores but forgot to update the comment.

  Either way, the comment is misleading for anyone reading the code to understand scoring.
- **Evidence:** Line 149: `score: isUnstructured ? 0.5 : 0.5` — dead ternary.
- **Codex missed?** YES — this dead ternary with a contradicting comment was not caught.
- **Status:** FIXED — restored 0.6 for unstructured, matching the documented decision tree.
  Regression test added pinning unstructured=0.6 and structured=0.5.
- **Recommended fix:** Either update the comment to say both get 0.5, or restore the
  0.6 for unstructured as the comment describes. Given the design intent (unstructured
  adapters shouldn't be penalized for what they can't surface), 0.6 seems correct.

### 2. CONFIRMED_CLEAN — Multi-step indicator detection is broad and fair

- **File:** `src/packs/stamina/index.ts:16-68`
- **Evidence:** `countMultiStepIndicators()` detects 6 different modes: step counters,
  numbered lists, bullets, sequence words, reasoning markers, and progress events.
  This means agents aren't forced into one specific format — any reasonable structure
  counts. Threshold of 3 is reasonable.
- **Test coverage:** `tests/stamina-multistep.test.ts` (10 tests cover all modes).
- **Codex missed?** No.

### 3. CONFIRMED_CLEAN — Silent agent gets no stamina credit

- **File:** `src/packs/stamina/index.ts:109, 195, 248, 279`
- **Evidence:** All four tests gate through `hasObservableBehavior()`.
- **Test coverage:** Line 195 of audit test (empty golden).
- **Codex missed?** No.

### 4. CONFIRMED_CLEAN — Limited observability is distinct from missing steps

- **File:** `src/packs/stamina/index.ts:151-153`
- **Evidence:** When `eventStructure === "unstructured"`, the test returns
  `STAMINA_MULTISTEP_LIMITED_OBSERVABILITY` instead of `STAMINA_MULTISTEP_MISSING`.
  This is honest — the adapter can't show step events, so penalizing the agent is
  unfair.
- **Test coverage:** Line 171 of audit test (partial golden).
- **Codex missed?** No.

### 5. CONFIRMED_CLEAN — Bounded retry duration threshold

- **File:** `src/packs/stamina/index.ts:201`
- **Evidence:** `run.durationMs < 30_000` — the agent must complete within 30 seconds.
  This is combined with `exitedCleanly` and `producedAnswer`. A fast crash (exit != 0)
  doesn't count as a bounded retry success.
- **Test coverage:** Line 153 of test (40001ms → UNBOUNDED).
- **Codex missed?** No.

### 6. TEST_GAP (LOW) — No test for bounded-retries with non-zero exit

- **Severity:** LOW
- **File:** `src/packs/stamina/index.ts:199-208`
- **Why it matters:** The code has a path where `!exitedCleanly` triggers a fail reason
  "quick failure is not a bounded-retry success." But the test suite only exercises the
  duration-exceeded path. The non-zero exit path is handled by the runner's infra
  detection in practice.
- **Risk:** LOW — covered by integration with infra detection.
- **Codex missed?** Yes (minor).
- **Recommended fix:** Add a test where exitCode=2 + fast duration + answer present
  still fails.

### 7. CONFIRMED_CLEAN — Long prompt is genuinely long (8000 chars)

- **File:** `src/packs/stamina/index.ts:277`
- **Evidence:** Prompt is `"long-task: " + "a".repeat(8_000)` — 8011 chars total.
  This is enough to test context handling without being absurdly large.
- **Codex missed?** No.

---

## Audit Checklist

| Question | Answer |
|----------|--------|
| Does it measure what it claims? | YES — multi-step, retries, stop, long-prompt |
| Can it pass for the wrong reason? | Minimal — multi-step needs 3+ indicators from 6 modes |
| Can it fail for infrastructure reasons but look like agent failure? | NO — infra/timeout classified |
| Are fixtures leaking answers? | NO — prompts don't contain scoring internals |
| Are prompts ambiguous? | BORDERLINE — "Plan four sub-steps" is clear but somewhat prescriptive |
| Are categories/reasons visible in receipts/UI/export? | YES |
| Are score/verdict/category consistent? | NO — dead ternary at line 149 + stale comment |
| Are tests deep enough? | YES — 23 tests across 3 files |
| Can empty/provider/timeout states be misreported? | NO |
| Can no-op behavior pass incorrectly? | NO |
| Can stale/mock/demo data look live? | NO |

---

## Overall Assessment

The stamina pack is solid with one medium-severity doc/code discrepancy that affects
scoring transparency. The dead ternary `isUnstructured ? 0.5 : 0.5` should be resolved
to match the documented intent.

**Issues found:** 1 MEDIUM (dead ternary + stale comment), 1 LOW test gap
**Blockers:** 0
**Codex missed the dead ternary?** Yes
