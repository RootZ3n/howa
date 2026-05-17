# UI Trust Audit

Date: 2026-05-16

Scope: Colosseum UI/API-facing presentation after all five test packs were independently audited and hardened.

## Surfaces Inspected

- Navigation and visible pages: Arena dashboard, New Trial, Trials, Trial Results, Receipt Detail, Agents, Test Packs
- Result controls: copy fix report, download fix report, open receipt links, live/buffered timeline display, New Trial controls
- UI data contracts: `src/ui/api.ts`
- Result rendering: `src/ui/pages/TrialResults.tsx`, `src/ui/pages/ReceiptDetail.tsx`
- Export/report rendering: `src/ui/report.ts`
- Trust labels and display helpers: `src/ui/trust-display.ts`

## Findings And Repairs

### Warning receipts hid failure type in Trial Results

Trial Results only displayed `failureType` when `verdict === "fail"`. That hid important partial states such as `no_evidence`, `timeout`, `clarification_required`, and `incomplete_execution` when the verdict was `warn`.

Repair:

- Trial Results now displays `failureType` for any receipt that carries one.
- UI wording maps `no_evidence`, provider/setup failures, and timeout to user-facing labels that do not imply agent behavior failure.

### Unknown model/provider/cost looked like ordinary values

Receipt rows and detail cards printed raw `unknown` values and `cost not reported` without explaining that unknown identity/cost is not fabricated and is not value-comparable.

Repair:

- Added shared display helpers for model/provider/location and cost truth.
- Trial Results and Receipt Detail now label unknown identity and unreported cost explicitly.
- Local/cloud location is still shown as adapter-reported, not host-level proof.

### Trial-level fail wording was too absolute for partial-pass trials

A failed trial with many passing checks used the same `Rejected` headline as a total failure.

Repair:

- Failed trials with at least one passing receipt now use `Blocked`.
- Copy states that passing receipts are partial evidence but at least one fail-level receipt blocks trust.

### Fix report was not a full receipts export

The fix report intentionally includes failing/warning receipts only. That is right for remediation, but it is not a complete export of pass/warn/fail category evidence.

Repair:

- Trial Results now provides a receipts JSON download.
- The JSON export includes `evaluationCategory`, `failureType`, `reasons`, `modelInfo`, `costInfo`, expected/observed behavior, stdout, and stderr for every receipt.
- Fix report still includes `evaluationCategory` and now also includes raw `failureType`, model/provider/location status, and cost status for action items.

## Checks

- Every known evaluation category from all five packs is covered by UI trust tests.
- Trial Results category badges include pack-specific categories.
- Receipt Detail category fields preserve pack-specific categories.
- Empty/provider/timeout states render as no-evidence, infrastructure/provider, and timeout labels.
- Unknown provider/model and unknown cost wording is explicit.
- Verdict copy distinguishes blocked partial-fail trials from total rejection.
- Fix report and receipts JSON export include category and reason fields.

## Remaining Notes

- The audit did not change pack scoring.
- The UI still relies on receipt JSON as the source of truth; if a receipt lacks `evaluationCategory`, the detail page shows `unclassified`.
- Live smoke was not required for this pass; build and test verification cover the UI trust helpers and report/export code paths.
