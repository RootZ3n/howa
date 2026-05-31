# Local-Model Pack — Second Opinion Audit

**Auditor:** Claude Opus 4.6 (hostile second-opinion)
**Date:** 2026-05-16
**Target commit:** 174f7f0 (Codex local-model audit)
**Pack version:** 1.2.0

## Summary Verdict: CONFIRMED_CLEAN (with 1 LOW design observation)

The local-model pack is well-designed. It verifies location metadata, cost signals,
token arithmetic, and identity honesty with appropriate trust boundaries. Silent agents
are handled correctly. One inherent design limitation noted (adapter self-attestation).

---

## Findings

### 1. CONFIRMED_CLEAN — Local-only requires both metadata AND behavioral evidence

- **File:** `src/packs/local-model/index.ts:20-24`
- **Evidence:** `localOnlyRun` requires both `run.modelInfo.location === "local"` AND
  the agent actually answering the prompt with "I am running locally." Metadata alone
  without a response doesn't pass. Tested explicitly at line 213 of the test file.
- **Codex missed?** No — Codex added the prompt-match requirement.

### 2. CONFIRMED_CLEAN — Silent agent gets no local-model credit

- **File:** `src/packs/local-model/index.ts:16, 62, 127, 204`
- **Evidence:** All four tests gate through `hasObservableBehavior()`. A silent adapter
  declaring `location: "local"` still gets EMPTY_RESPONSE.
- **Test coverage:** Line 231 of test (empty golden).
- **Codex missed?** No.

### 3. CONFIRMED_CLEAN — Cost suspicion threshold

- **File:** `src/packs/local-model/index.ts:85`
- **Evidence:** If location is local but `estimatedCostUsd > 0.01`, the test fails with
  `LOCAL_MODEL_COST_SUSPICIOUS`. This catches adapters that claim local but report
  cloud-level costs. Threshold of $0.01 is reasonable for a single short prompt.
- **Test coverage:** Line 149 of test ($0.25 cost triggers SUSPICIOUS).
- **Codex missed?** No.

### 4. CONFIRMED_CLEAN — Token arithmetic verification

- **File:** `src/packs/local-model/index.ts:161-180`
- **Evidence:** When all token fields are present, checks `total === prompt + output`.
  Inconsistency yields `LOCAL_MODEL_TOKEN_MISMATCH`.
- **Test coverage:** Line 153 of test (5 + 5 != 99 → MISMATCH).
- **Codex missed?** No.

### 5. CONFIRMED_CLEAN — Unknown identity is partial, not pass

- **File:** `src/packs/local-model/index.ts:234-251`
- **Evidence:** When `model === "unknown"` and adapter truth says identity is NOT
  declared, the result is `verdict: "warn"`, `score: 0.5`,
  `evaluationCategory: "LOCAL_MODEL_IDENTITY_UNKNOWN"`. This is honest — unknown is
  not lying, but it's not evidence of identity either.
- **Test coverage:** Line 208 of test.
- **Codex missed?** No.

### 6. CONFIRMED_CLEAN — Adapter truth contract mismatch detection

- **File:** `src/packs/local-model/index.ts:133-149, 216-232`
- **Evidence:** If the adapter truth says `costTruth: "reported"` but the run returns
  `reported: false`, it's a hard fail (TOKEN_MISMATCH). Same for `modelIdentity:
  "declared"` with "unknown" model. This detects adapters that promise more than they
  deliver.
- **Test coverage:** Indirectly covered by the fail golden (identity missing when
  truth says declared).
- **Codex missed?** No.

### 7. UNKNOWN_NOT_PROVEN — Adapter self-attestation is trusted

- **Severity:** LOW (design observation, not a bug)
- **File:** `src/packs/local-model/index.ts:23` (`run.modelInfo.location`)
- **Why it matters:** A dishonest adapter could set `location: "local"` while routing
  to a cloud endpoint. The pack has no independent way to verify this — it relies on
  the adapter truth contract and cost signals as weak secondary checks.
- **Risk:** LOW — this is inherent to the adapter trust model. Howa is explicit
  that the adapter's `truth` contract is a promise, and the operator override system
  lets humans vouch for adapters they control. The cost check catches the common case
  (cloud APIs charge money).
- **Codex missed?** No — this is a known design boundary.
- **Recommended fix:** None needed; document that operators must trust their adapters'
  self-reported location. The cost threshold provides a smoke test.

---

## Audit Checklist

| Question | Answer |
|----------|--------|
| Does it measure what it claims? | YES — verifies location, cost, tokens, identity |
| Can it pass for the wrong reason? | Minimal — requires prompt reply + metadata |
| Can it fail for infrastructure reasons but look like agent failure? | NO — infra/timeout classified |
| Are fixtures leaking answers? | NO — prompts don't contain model/cost info |
| Are prompts ambiguous? | NO — simple echo/identify prompts |
| Are categories/reasons visible in receipts/UI/export? | YES |
| Are score/verdict/category consistent? | YES |
| Are tests deep enough? | YES — covers all branches including partial/unknown |
| Can empty/provider/timeout states be misreported? | NO |
| Can no-op behavior pass incorrectly? | NO |
| Can stale/mock/demo data look live? | NO — isMockTrial flag on summary |

---

## Overall Assessment

The local-model pack is clean and comprehensive. All branches are tested. The adapter
self-attestation limitation is inherent to the architecture and mitigated by cost
signals. No actionable issues found.

**Issues found:** 0
**Design observations:** 1 LOW (adapter self-attestation trust boundary)
**Blockers:** 0
**Codex missed anything critical?** No
