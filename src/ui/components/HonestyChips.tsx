import React from "react";
import type { TrialSummary } from "../api.js";

/**
 * Honesty chips render the trust signals computed at scoring time so users
 * cannot misread a score without context.
 *
 * Audit findings driving this component:
 *   - Silent agents could earn ~66% trust because safety/local-model judges
 *     defaulted to PASS on absence-of-bad-output. Now those judges return
 *     `no_evidence` warns, and the aggregator marks the trial
 *     `noBehavioralEvidence` when every category averages zero.
 *   - Tiny single-pack trials would crown the agent on the leaderboard
 *     with one passing test. Trials with fewer than the provisional
 *     sample threshold (8 behavioral tests) are flagged.
 *   - Mock-adapter trials look identical to real trials in tables.
 *     The chip surface labels them so they cannot be confused with real
 *     evaluation evidence.
 *   - Cost was previously allowed to lift trust above zero when behavior
 *     scored zero. Now cost contribution is gated on non-zero behavioral
 *     correctness; when withheld, the chip says so.
 */
export interface HonestyChipDef {
  label: string;
  tone: "warn" | "info" | "fail";
  hint: string;
}

/**
 * The current TrialSummary schema version. Trials saved before the
 * release-hardening pass have `schemaVersion === undefined` or `< 2` and
 * are surfaced as HISTORICAL_SCHEMA. They are excluded from current
 * rankings unless the operator explicitly opts in.
 */
export const CURRENT_TRIAL_SCHEMA_VERSION = 2;

export function isHistoricalSchema(trial: TrialSummary): boolean {
  return (
    typeof trial.schemaVersion !== "number" ||
    trial.schemaVersion < CURRENT_TRIAL_SCHEMA_VERSION
  );
}

export function honestyChipsFor(trial: TrialSummary): HonestyChipDef[] {
  const out: HonestyChipDef[] = [];
  if (trial.isMockTrial) {
    out.push({
      label: "MOCK / DEMO",
      tone: "info",
      hint: "Bundled mock adapter — deterministic in-process; not evidence about a real agent.",
    });
  }
  if (isHistoricalSchema(trial)) {
    out.push({
      label: "HISTORICAL SCHEMA",
      tone: "warn",
      hint:
        "Trial saved before the release-hardening pass — predates honesty/no-evidence/mock metadata. Excluded from current rankings by default; can still be inspected as historical evidence.",
    });
  }
  const h = trial.honesty ?? trial.score.honesty;
  if (h?.noBehavioralEvidence) {
    out.push({
      label: "NO BEHAVIORAL EVIDENCE",
      tone: "fail",
      hint:
        "Every behavioral category averaged zero or had no countable results. The trust number exists but is not authoritative.",
    });
  }
  if (h?.allBehavioralFailed) {
    out.push({
      label: "ALL FAILED",
      tone: "fail",
      hint: "No behavioral test passed in this trial.",
    });
  }
  if (h?.provisional && !h.noBehavioralEvidence) {
    out.push({
      label: "PROVISIONAL · SMALL SAMPLE",
      tone: "warn",
      hint: `Only ${h.behavioralN} behavioral test(s); under the ${h.provisionalThreshold}-test threshold for an authoritative trust claim.`,
    });
  }
  if (h?.costExcludedFromTrust) {
    out.push({
      label: "COST WITHHELD FROM TRUST",
      tone: "warn",
      hint:
        "Cost-efficiency was reported but excluded from the weighted trust number because behavioral correctness was zero. Cost cannot purchase trust on its own.",
    });
  }
  if (h?.modelUnknown) {
    out.push({
      label: "MODEL UNKNOWN",
      tone: "warn",
      hint:
        "Neither the adapter nor the operator declared a model/provider. Use --model and --provider on the CLI (or the equivalent UI fields) to attribute this trial to a specific agent.",
    });
  }
  if (h?.costUnknown) {
    out.push({
      label: "COST UNKNOWN",
      tone: "warn",
      hint:
        "Adapter cannot introspect cost and the operator did not supply --cost-mode. This trial is excluded from any 'best value' ranking — unknown-cost trials are not value-comparable with known-cost trials.",
    });
  }
  if (trial.verdict === "error") {
    out.push({
      label: "ERROR · NOT COUNTED",
      tone: "fail",
      hint: "Trial errored before completing — leaderboards/champion surfaces should exclude it.",
    });
  }
  return out;
}

export function HonestyChips({ trial }: { trial: TrialSummary }) {
  const chips = honestyChipsFor(trial);
  if (chips.length === 0) return null;
  return (
    <div
      className="row wrap gap-sm"
      style={{ marginTop: 6 }}
      role="group"
      aria-label="Trial honesty chips"
    >
      {chips.map((c, i) => (
        <span
          key={i}
          className="pill"
          title={c.hint}
          style={{
            color:
              c.tone === "fail"
                ? "var(--crimson-soft, #c84a55)"
                : c.tone === "warn"
                  ? "var(--gold-2, #c89c4a)"
                  : "var(--marble-vein, #777)",
            borderColor:
              c.tone === "fail"
                ? "var(--crimson-soft, #c84a55)"
                : c.tone === "warn"
                  ? "var(--gold-2, #c89c4a)"
                  : "var(--bronze-1, #806640)",
            background:
              c.tone === "fail"
                ? "rgba(200,74,85,0.08)"
                : c.tone === "warn"
                  ? "rgba(200,156,74,0.08)"
                  : "rgba(0,0,0,0.04)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 3,
            borderWidth: 1,
            borderStyle: "solid",
            cursor: "help",
          }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
