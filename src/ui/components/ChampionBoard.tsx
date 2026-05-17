import React from "react";
import { Link } from "react-router-dom";
import type { TrialSummary } from "../api.js";
import { VerdictPill } from "./VerdictPill.js";
import { isHistoricalSchema } from "./HonestyChips.js";

/**
 * A trial is eligible for the Champion Board only if it represents
 * authoritative behavioral evidence. The pre-release audit found four
 * shapes that must NOT crown an agent:
 *   - mock-adapter trials (deterministic in-process; not real evidence),
 *   - no-evidence trials (every behavioral category averaged zero — see
 *     the silent-agent inflation bug fix),
 *   - errored trials (the runner crashed before scoring real behavior),
 *   - schema-v1 historical trials (predate the honesty-flag schema; we
 *     can't recompute their honesty signals after the fact, so they are
 *     excluded by default and can be opted into via `includeHistorical`).
 * Provisional/small-sample trials are still ranked but flagged with a
 * label so a one-pack run cannot silently outrank a full-suite run.
 */
export function isChampionEligible(
  t: TrialSummary,
  opts: { includeHistorical?: boolean } = {},
): boolean {
  if (t.isMockTrial) return false;
  if (t.verdict === "error" || t.verdict === "skipped") return false;
  const h = t.honesty ?? t.score.honesty;
  if (h?.noBehavioralEvidence) return false;
  if (!opts.includeHistorical && isHistoricalSchema(t)) return false;
  return true;
}

/**
 * "Best value" is a separate ranking surface from the Champion Board.
 * A trial is eligible only if its cost truth is known — otherwise it
 * cannot be value-compared with known-cost trials at all. Mock trials
 * are also excluded (their cost is always zero by construction).
 */
export function isBestValueEligible(
  t: TrialSummary,
  opts: { includeHistorical?: boolean } = {},
): boolean {
  if (!isChampionEligible(t, opts)) return false;
  const h = t.honesty ?? t.score.honesty;
  if (h?.costUnknown) return false;
  return true;
}

export function ChampionBoard({
  trials,
  includeHistorical,
}: {
  trials: TrialSummary[];
  /**
   * Opt-in to include schema-v1 historical trials in ranking. Default
   * false — those trials predate the honesty schema and should not
   * contaminate current rankings.
   */
  includeHistorical?: boolean;
}) {
  const eligible = trials.filter((t) => isChampionEligible(t, { includeHistorical }));
  const excluded = trials.length - eligible.length;
  const top = [...eligible]
    .sort((a, b) => b.score.trust - a.score.trust)
    .slice(0, 8);

  if (top.length === 0) {
    return (
      <div className="empty">
        No champions yet.
        {excluded > 0
          ? ` (${excluded} trial${excluded === 1 ? "" : "s"} excluded — mock, errored, no behavioral evidence, or historical-schema.)`
          : " Open a trial to crown one."}
      </div>
    );
  }

  return (
    <div>
      <div className="champion" style={{ borderBottomColor: "var(--bronze-1)", color: "var(--marble-vein)" }}>
        <div>RANK</div>
        <div>AGENT · TRIAL</div>
        <div className="right">PASS</div>
        <div className="right">TRUST</div>
        <div className="right">VERDICT</div>
      </div>
      {top.map((t, i) => {
        const h = t.honesty ?? t.score.honesty;
        const isProvisional = !!h?.provisional;
        return (
          <div className="champion" key={t.trialId}>
            <div className="rank">{romanNumeral(i + 1)}</div>
            <div className="name">
              <Link to={`/trial/${t.trialId}`}>{t.agentId}</Link>
              <div className="muted" style={{ fontSize: 11 }}>
                {t.trialId} · {new Date(t.startedAt).toLocaleString()}
                {isProvisional ? (
                  <span
                    style={{ marginLeft: 6, color: "var(--gold-2, #c89c4a)" }}
                    title={`Only ${h?.behavioralN} behavioral test(s); under the ${h?.provisionalThreshold}-test threshold for an authoritative trust claim.`}
                  >
                    · provisional
                  </span>
                ) : null}
              </div>
            </div>
            <div className="right">
              {t.passCount}/{t.testCount}
            </div>
            <div className="right">{Math.round(t.score.trust * 100)}%</div>
            <div className="right">
              <VerdictPill verdict={t.verdict} />
            </div>
          </div>
        );
      })}
      {excluded > 0 ? (
        <div
          className="muted"
          style={{ fontSize: 11, marginTop: 8, paddingTop: 6, borderTop: "1px dashed var(--bracket, rgba(0,0,0,0.15))" }}
          title="Mock-adapter, errored, and no-behavioral-evidence trials are excluded from the Champion Board so they cannot crown an agent."
        >
          {excluded} trial{excluded === 1 ? "" : "s"} excluded from ranking — see the Trials page for the full list.
        </div>
      ) : null}
    </div>
  );
}

function romanNumeral(n: number): string {
  const map: [number, string][] = [
    [10, "X"], [9, "IX"], [8, "VIII"], [7, "VII"], [6, "VI"],
    [5, "V"], [4, "IV"], [3, "III"], [2, "II"], [1, "I"],
  ];
  for (const [k, v] of map) if (n >= k) return v + (n > k ? "" : "");
  return String(n);
}
