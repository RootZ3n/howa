import { describe, it, expect } from "vitest";
import { buildAgentFixReport } from "@colosseum/ui/report.js";
import type { Receipt, TrialSummary } from "@colosseum/ui/api.js";

/**
 * Audit coverage for the markdown export. The pre-release audit found that
 * downstream consumers (humans and "fixing" agents) read the report verbatim
 * and could quote a high trust number without knowing the trial had no
 * behavioral evidence, used the mock adapter, was provisional, etc.
 *
 * These tests pin that the export now surfaces the trust-honesty stamps.
 */

function summary(extra: Partial<TrialSummary> = {}): TrialSummary {
  return {
    trialId: "trial-fake",
    agentId: "test",
    adapter: "test",
    packs: ["safety"],
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    verdict: "warn",
    score: {
      passRate: 0.5,
      trust: 0.5,
      perCategory: [
        { category: "safety", value: 0, n: 1, reasons: [] },
      ],
      costEfficiency: { value: 0.5, n: 0, reasons: [] },
      reasons: [],
      honesty: {
        provisional: false,
        noBehavioralEvidence: false,
        allBehavioralFailed: false,
        costExcludedFromTrust: false,
        noBehavioralCategories: false,
        behavioralN: 1,
        provisionalThreshold: 8,
      },
    },
    testCount: 1,
    passCount: 0,
    failCount: 1,
    velumDecision: "allow",
    isMockTrial: false,
    schemaVersion: 2,
    honesty: {
      provisional: false,
      noBehavioralEvidence: false,
      allBehavioralFailed: false,
      costExcludedFromTrust: false,
      noBehavioralCategories: false,
      behavioralN: 1,
      provisionalThreshold: 8,
    },
    ...extra,
  };
}

describe("export honesty: buildAgentFixReport surfaces trust-honesty stamps", () => {
  it("includes MOCK / DEMO when the trial used the mock adapter", () => {
    const t = summary({ isMockTrial: true });
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/MOCK \/ DEMO/);
  });

  it("includes NO BEHAVIORAL EVIDENCE when honesty flag is set", () => {
    const t = summary({
      honesty: {
        provisional: true,
        noBehavioralEvidence: true,
        allBehavioralFailed: true,
        costExcludedFromTrust: false,
        noBehavioralCategories: false,
        behavioralN: 4,
        provisionalThreshold: 8,
      },
    });
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/NO BEHAVIORAL EVIDENCE/);
    expect(md).toMatch(/ALL BEHAVIORAL FAILED/);
  });

  it("includes PROVISIONAL · SMALL SAMPLE when behavioralN is below threshold", () => {
    const t = summary({
      honesty: {
        provisional: true,
        noBehavioralEvidence: false,
        allBehavioralFailed: false,
        costExcludedFromTrust: false,
        noBehavioralCategories: false,
        behavioralN: 4,
        provisionalThreshold: 8,
      },
    });
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/PROVISIONAL/);
    expect(md).toMatch(/4 behavioral test/);
  });

  it("includes COST WITHHELD FROM TRUST when honesty flag set", () => {
    const t = summary({
      honesty: {
        provisional: false,
        noBehavioralEvidence: false,
        allBehavioralFailed: true,
        costExcludedFromTrust: true,
        noBehavioralCategories: false,
        behavioralN: 5,
        provisionalThreshold: 8,
      },
    });
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/COST WITHHELD FROM TRUST/);
  });

  it("includes ERROR · NOT COUNTED when verdict is error", () => {
    const t = summary({ verdict: "error" });
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/ERROR · NOT COUNTED/);
  });

  it("emits no honesty section for a clean, non-flagged trial", () => {
    const md = buildAgentFixReport(summary(), []);
    expect(md).not.toMatch(/Honesty stamps:/);
  });
});

describe("export honesty: stale receipts (Receipt not present)", () => {
  it("a trial summary missing honesty (older record) does not crash the report builder", () => {
    const t = summary();
    delete (t as Partial<TrialSummary>).honesty;
    delete (t.score as { honesty?: unknown }).honesty;
    const md = buildAgentFixReport(t, []);
    expect(md).toMatch(/^# Colosseum Trial Fix Report/);
  });
});

describe("export honesty: champion-eligibility logic", () => {
  it("isChampionEligible excludes mock, errored, and no-evidence trials", async () => {
    const { isChampionEligible } = await import(
      "@colosseum/ui/components/ChampionBoard.js"
    );
    expect(isChampionEligible(summary({ isMockTrial: true }))).toBe(false);
    expect(isChampionEligible(summary({ verdict: "error" }))).toBe(false);
    expect(
      isChampionEligible(
        summary({
          honesty: {
            provisional: true,
            noBehavioralEvidence: true,
            allBehavioralFailed: true,
            costExcludedFromTrust: false,
            noBehavioralCategories: false,
            behavioralN: 0,
            provisionalThreshold: 8,
          },
        }),
      ),
    ).toBe(false);
    // A clean, non-mock, non-error, behavior-bearing trial is eligible.
    expect(isChampionEligible(summary())).toBe(true);
  });
});
