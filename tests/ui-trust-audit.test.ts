import { describe, expect, it } from "vitest";
import {
  ALL_EVALUATION_CATEGORIES,
  buildReceiptsJsonExport,
  failureTypeLabel,
  formatCostStatus,
  formatModelStatus,
  receiptBadges,
  trialVerdictCopy,
} from "@colosseum/ui/trust-display.js";
import { buildAgentFixReport } from "@colosseum/ui/report.js";
import type { Receipt, TrialSummary } from "@colosseum/ui/api.js";

function trial(extra: Partial<TrialSummary> = {}): TrialSummary {
  return {
    trialId: "trial-ui",
    agentId: "agent-ui",
    adapter: "adapter-ui",
    packs: ["safety", "truthfulness", "repo-editing", "local-model", "stamina"],
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    verdict: "warn",
    score: {
      passRate: 0.5,
      trust: 0.55,
      perCategory: [
        { category: "safety", value: 0, n: 1, reasons: ["1 test(s); 1 failed."] },
      ],
      costEfficiency: { value: 0, n: 0, reasons: ["No cost data reported."] },
      reasons: ["Pass rate: 50%"],
    },
    testCount: 2,
    passCount: 1,
    failCount: 1,
    velumDecision: "warn",
    schemaVersion: 2,
    ...extra,
  };
}

function receipt(extra: Partial<Receipt> = {}): Receipt {
  return {
    receiptId: "trial-ui/safety.prompt-injection",
    trialId: "trial-ui",
    testId: "safety.prompt-injection",
    agentId: "agent-ui",
    adapter: "adapter-ui",
    modelInfo: { model: "unknown", provider: "unknown", location: "unknown" },
    costInfo: { reported: false, note: "adapter cannot report cost" },
    prompt: "test prompt",
    expectedBehavior: "expected behavior",
    observedBehavior: "- behavior: present",
    verdict: "warn",
    failureType: "no_evidence",
    evaluationCategory: "EMPTY_RESPONSE",
    reasons: ["Agent produced no observable behavior."],
    artifacts: [],
    stdoutSummary: "",
    stderrSummary: "",
    velum: { decision: "allow", findings: [], safeText: "" },
    events: [],
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    ...extra,
  };
}

describe("UI trust audit: category and state rendering helpers", () => {
  it("TrialResults badge set can display every pack evaluationCategory", () => {
    for (const category of ALL_EVALUATION_CATEGORIES) {
      expect(
        receiptBadges(
          receipt({
            evaluationCategory: category,
            verdict: category === "PASS" ? "pass" : "warn",
            failureType: category === "PASS" ? undefined : "incomplete_execution",
          }),
        ),
      ).toContain(category);
    }
  });

  it("ReceiptDetail evaluation fields preserve every pack evaluationCategory", () => {
    for (const category of ALL_EVALUATION_CATEGORIES) {
      const r = receipt({ evaluationCategory: category });
      expect(r.evaluationCategory).toBe(category);
      expect(receiptBadges(r)).toContain(category);
    }
  });

  it("empty, provider, and timeout outcomes are labeled as no-evidence/infra states", () => {
    expect(failureTypeLabel("no_evidence")).toBe("No evidence");
    expect(failureTypeLabel("infrastructure_failure")).toBe("Infrastructure/provider");
    expect(failureTypeLabel("adapter_setup_failed")).toBe("Infrastructure/provider");
    expect(failureTypeLabel("timeout")).toBe("Timeout");
  });

  it("unknown provider/model and unreported cost use honest wording", () => {
    const model = formatModelStatus({
      model: "unknown",
      provider: "unknown",
      location: "unknown",
    });
    expect(model.unknown).toBe(true);
    expect(model.primary).toContain("provider unknown");
    expect(model.primary).toContain("model unknown");
    expect(model.detail).toContain("location unknown");

    const cost = formatCostStatus({
      reported: false,
      note: "not available from adapter",
    });
    expect(cost.unknown).toBe(true);
    expect(cost.primary).toBe("Cost not reported");
    expect(cost.detail).toMatch(/not value-comparable/);
  });

  it("verdict copy does not present partial fail results as absolute total failure", () => {
    const blocked = trialVerdictCopy(
      trial({ verdict: "fail", passCount: 18, failCount: 1, testCount: 19 }),
    );
    expect(blocked.headline).toBe("Blocked");
    expect(blocked.sub).toMatch(/Some checks passed/);
    expect(blocked.sub).toMatch(/partial evidence/);

    const rejected = trialVerdictCopy(
      trial({ verdict: "fail", passCount: 0, failCount: 19, testCount: 19 }),
    );
    expect(rejected.headline).toBe("Rejected");
  });
});

describe("UI trust audit: exports include categories, reasons, and identity/cost", () => {
  it("fix report includes evaluationCategory, raw failureType, reasons, model, and cost", () => {
    const r = receipt({
      verdict: "fail",
      failureType: "infrastructure_failure",
      evaluationCategory: "INFRA_FAILURE",
      reasons: ["No API key found."],
    });
    const md = buildAgentFixReport(trial({ verdict: "fail" }), [r]);
    expect(md).toContain("Evaluation category: INFRA_FAILURE");
    expect(md).toContain("Failure type: infrastructure_failure");
    expect(md).toContain("No API key found.");
    expect(md).toContain("provider unknown");
    expect(md).toContain("Cost not reported");
  });

  it("receipts JSON export includes category, reason, failureType, modelInfo, and costInfo for pass and warn receipts", () => {
    const exported = JSON.parse(
      buildReceiptsJsonExport(trial(), [
        receipt({
          verdict: "pass",
          failureType: undefined,
          evaluationCategory: "LOCAL_MODEL_LOCAL_RUN",
          reasons: ["Adapter reports local location."],
          modelInfo: { model: "llama3", provider: "ollama", location: "local" },
          costInfo: { reported: true, estimatedCostUsd: 0, totalTokens: 10 },
        }),
        receipt({
          verdict: "warn",
          failureType: "timeout",
          evaluationCategory: "TIMEOUT",
          reasons: ["timeout: deadline exceeded"],
        }),
      ]),
    ) as {
      receipts: Array<{
        verdict: string;
        failureType: string | null;
        evaluationCategory: string | null;
        reasons: string[];
        modelInfo: Receipt["modelInfo"];
        costInfo: Receipt["costInfo"];
      }>;
    };

    expect(exported.receipts[0].evaluationCategory).toBe("LOCAL_MODEL_LOCAL_RUN");
    expect(exported.receipts[0].reasons).toContain("Adapter reports local location.");
    expect(exported.receipts[0].modelInfo.location).toBe("local");
    expect(exported.receipts[0].costInfo.reported).toBe(true);
    expect(exported.receipts[1].failureType).toBe("timeout");
    expect(exported.receipts[1].evaluationCategory).toBe("TIMEOUT");
  });
});
