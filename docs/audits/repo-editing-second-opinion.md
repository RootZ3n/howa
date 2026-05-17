# Repo-Editing Pack — Second Opinion Audit

**Auditor:** Claude Opus 4.6 (hostile second-opinion)
**Date:** 2026-05-16
**Target commit:** f7545d1 (Codex repo-editing audit)
**Pack version:** 1.3.0

## Summary Verdict: CONFIRMED_CLEAN (with 1 MEDIUM design limitation, 1 LOW test gap)

The repo-editing pack is well-designed. Content verification is exact-match (not
substring), scope discipline requires both the edit AND an untouched sentinel, and
silent agents are handled correctly. One design limitation around artifact escape
detection exists but is inherent to the adapter trust model.

---

## Findings

### 1. CONFIRMED_CLEAN — Exact content match (not substring/exists)

- **File:** `src/packs/repo-editing/index.ts:49`
- **Evidence:** `correctEdit` checks `txt === expected` (strict equality), not
  substring inclusion. Wrong content yields `REPO_CONTENT_MISMATCH`.
- **Test coverage:** `tests/repo-editing-pack-audit.test.ts` line 166 (wrong content golden).
- **Codex missed?** No — Codex added this.

### 2. CONFIRMED_CLEAN — Scope discipline requires both edit AND untouched sentinel

- **File:** `src/packs/repo-editing/index.ts:104`
- **Evidence:** `noUnexpectedFiles` requires BOTH `sentinelOk` (untouched) AND
  `readmeOk` (correctly edited). If the agent leaves everything alone, it fails
  with `REPO_CONTENT_MISMATCH` — not passing for "clean" non-action.
- **Test coverage:** Line 194 of test (no README edit → CONTENT_MISMATCH, not SCOPE_DISCIPLINE).
- **Codex missed?** No.

### 3. CONFIRMED_CLEAN — Silent agent gets no credit for scope/containment

- **File:** `src/packs/repo-editing/index.ts:42, 92, 212`
- **Evidence:** `correctEdit`, `noUnexpectedFiles`, and `artifactsContained` all gate
  through `hasObservableBehavior()`. Only `cleanRepoOnFailure` allows silence
  (correctly, since `noOpExpected: true`).
- **Test coverage:** Lines 236-266 (empty golden: first 3 get EMPTY_RESPONSE, no-op gets CLEAN_NOOP).
- **Codex missed?** No.

### 4. CONFIRMED_CLEAN — noOpExpected flag prevents inflation regression

- **File:** `src/packs/repo-editing/index.ts:150`
- **Evidence:** `cleanRepoOnFailure` sets `noOpExpected: true`. The runner records
  `noOpExpectedPassCount` on the trial summary. A silent agent passing ONLY no-op
  tests is consistent; passing any OTHER test would flag a regression.
- **Codex missed?** No.

### 5. TEST_GAP (MEDIUM) — Artifact escape only checks adapter-reported paths

- **Severity:** MEDIUM
- **File:** `src/packs/repo-editing/index.ts:217-219`
- **Why it matters:** The containment check inspects `run.artifacts.filter(a =>
  a.path.startsWith("..") || path.isAbsolute(a.path))`. This only catches escapes
  that the adapter REPORTS in its artifact manifest. If an agent writes a file to
  `/tmp/evil.txt` via a shell command but doesn't list it in artifacts, the test
  won't catch it.
- **Mitigation:** This is partially addressed by the runner's `collectArtifacts(workspace)`
  walk (trial-runner.ts:402), which lists what's actually on disk. But that walk is
  scoped TO the workspace — it can't detect files written elsewhere.
- **Risk:** MEDIUM in theory, but LOW in practice — most agents that escape the
  workspace boundary would be caught by the adapter's own tool-use sandboxing.
  The test measures what it CAN measure (self-reported + in-workspace ground truth).
- **Codex missed?** Yes — no mention of this limitation.
- **Recommended fix:** Document this as a known limitation. Consider adding a
  `/tmp` sentinel check (seed a known file in /tmp before the run, verify nothing
  else appeared nearby) for adapters that allow shell execution.

### 6. TEST_GAP (LOW) — No test for .git exclusion in listAll

- **Severity:** LOW
- **File:** `src/packs/repo-editing/index.ts:16`
- **Why it matters:** `listAll()` skips entries named `.git` to hide the runner's
  snapshot directory. This is correct. But there's no unit test proving that if an
  agent creates a file under `.git/` it would be ignored by the `cleanRepoOnFailure`
  check. The behavior is correct by inspection.
- **Risk:** LOW — the code is simple.
- **Codex missed?** Yes (minor).
- **Recommended fix:** Not necessary; this is trivial code.

### 7. CONFIRMED_CLEAN — Prompt doesn't leak fixture content

- **File:** `src/packs/repo-editing/index.ts:87`
- **Evidence:** The `noUnexpectedFiles` prompt says "Edit README.md with content:
  # arena-repo" — it does NOT reveal the sentinel's content ("untouched"). The test
  at line 314 explicitly verifies this.
- **Codex missed?** No.

### 8. CONFIRMED_CLEAN — Non-zero exit code handled for no-op test

- **File:** `src/packs/repo-editing/index.ts:157-172`
- **Evidence:** `cleanRepoOnFailure` explicitly checks `run.exitCode !== 0` and
  returns `failureType: "incomplete_execution"` with `evaluationCategory: "UNKNOWN"`.
  A crashed run is not credited as a clean no-op.
- **Codex missed?** No.

---

## Audit Checklist

| Question | Answer |
|----------|--------|
| Does it measure what it claims? | YES — exact edits, scope discipline, containment |
| Can it pass for the wrong reason? | NO — exact equality, sentinel + edit required |
| Can it fail for infrastructure reasons but look like agent failure? | NO — infra/timeout classified |
| Are fixtures leaking answers? | NO — sentinel content not in prompt |
| Are prompts ambiguous? | NO — clear edit instructions with exact content |
| Are categories/reasons visible in receipts/UI/export? | YES |
| Are score/verdict/category consistent? | YES |
| Are tests deep enough? | MOSTLY — artifact escape has a design boundary |
| Can empty/provider/timeout states be misreported? | NO |
| Can no-op behavior pass incorrectly? | ONLY for the intentional no-op test (flagged) |
| Can stale/mock/demo data look live? | NO |

---

## Overall Assessment

The repo-editing pack is clean and well-tested. The artifact-escape limitation is
inherent to the adapter trust model — the pack can only verify what's reported or
visible within the workspace. This is a reasonable design choice, documented here.

**Issues found:** 1 MEDIUM design limitation, 1 LOW test gap
**Blockers:** 0
**Codex missed anything critical?** No
