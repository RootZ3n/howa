import { describe, expect, it } from "vitest";
import {
  buildCapabilityMatrix,
  CANONICAL_CAPABILITIES,
  type CapabilityKey,
} from "@colosseum/capabilities.js";
import { adapterIds, getAdapter } from "@colosseum/adapters/registry.js";
import type { Receipt } from "@colosseum/receipts/receipt.js";
import type { TrialSummary } from "@colosseum/storage/index.js";

function trial(extra: Partial<TrialSummary> = {}): TrialSummary {
  return {
    trialId: "trial-capability",
    agentId: "mock",
    adapter: "mock",
    packs: ["repo-editing"],
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    verdict: "pass",
    score: {
      passRate: 1,
      trust: 1,
      perCategory: [],
      costEfficiency: { category: "overall", value: 0, n: 0, reasons: [] },
      reasons: [],
      honesty: {
        provisional: true,
        noBehavioralEvidence: false,
        allBehavioralFailed: false,
        costExcludedFromTrust: false,
        noBehavioralCategories: false,
        behavioralN: 1,
        provisionalThreshold: 8,
      },
    },
    testCount: 1,
    passCount: 1,
    failCount: 0,
    velumDecision: "allow",
    colosseumVersion: "test",
    gitCommit: "test",
    adapterVersion: "test",
    packVersions: { "repo-editing": "test" },
    adapterTruth: {
      modelIdentity: "declared",
      costTruth: "reported",
      eventStructure: "structured",
      toolSupport: true,
    },
    ...extra,
  };
}

function receipt(extra: Partial<Receipt> = {}): Receipt {
  return {
    receiptId: "trial-capability/repo.edit",
    trialId: "trial-capability",
    testId: "repo.edit",
    agentId: "mock",
    adapter: "mock",
    adapterVersion: "test",
    adapterTruth: {
      modelIdentity: "declared",
      costTruth: "reported",
      eventStructure: "structured",
      toolSupport: true,
    },
    packId: "repo-editing",
    packVersion: "test",
    colosseumVersion: "test",
    gitCommit: "test",
    modelInfo: {
      model: "mock-deterministic-1",
      provider: "colosseum-mock",
      location: "local",
    },
    costInfo: {
      reported: true,
      estimatedCostUsd: 0,
      promptTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    prompt: "edit file",
    expectedBehavior: "edit file",
    observedBehavior: "edited",
    verdict: "pass",
    reasons: ["ok"],
    artifacts: [{ path: "out/result.txt", bytes: 2 }],
    stdoutSummary: "wrote out/result.txt",
    stderrSummary: "",
    repoDiffSummary: "diff",
    repoDiffStatus: "changed",
    velum: { decision: "allow", agentDecision: "allow", findings: [], safeText: "" },
    events: [{ ts: 1, kind: "tool_call", text: "write_file out/result.txt" }],
    streamMode: "live",
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    ...extra,
  };
}

describe("canonical capability matrix", () => {
  it("every registered agent returns every canonical capability key", () => {
    for (const id of adapterIds()) {
      const matrix = buildCapabilityMatrix(getAdapter(id));
      expect(Object.keys(matrix).sort()).toEqual([...CANONICAL_CAPABILITIES].sort());
      for (const key of CANONICAL_CAPABILITIES) {
        expect(matrix[key].key).toBe(key);
        expect(matrix[key].state).toMatch(
          /^(PROVEN|SUPPORTED_NOT_PROVEN|UNSUPPORTED|BLOCKED_BY_CONFIG|NOT_TESTED|UNKNOWN)$/,
        );
      }
    }
  });

  it("covers Luna, Squidley, OpenClaw, Aedis, Hermes, Generic CLI, and Mock", () => {
    for (const id of [
      "luna",
      "squidley",
      "openclaw",
      "aedis",
      "hermes",
      "generic-cli",
      "mock",
    ]) {
      const matrix = buildCapabilityMatrix(getAdapter(id));
      expect(CANONICAL_CAPABILITIES.every((key) => Boolean(matrix[key]))).toBe(true);
    }
  });

  it("static support is supported-not-proven, not proven", () => {
    const matrix = buildCapabilityMatrix(getAdapter("mock"));
    expect(matrix.toolUse.state).toBe("SUPPORTED_NOT_PROVEN");
    expect(matrix.toolUse.evidence.source).toBe("static");
  });

  it("unsupported capabilities are explicit, not missing", () => {
    const matrix = buildCapabilityMatrix(getAdapter("luna"));
    expect(matrix.streaming.state).toBe("UNSUPPORTED");
    expect(matrix.fileEditing.state).toBe("UNSUPPORTED");
    expect(matrix.shellExecution.state).toBe("UNSUPPORTED");
  });

  it("receipt evidence can upgrade claimed support to proven", () => {
    const t = trial({ liveMode: "live" });
    const r = receipt();
    const matrix = buildCapabilityMatrix(getAdapter("mock"), {
      trials: [t],
      receiptsByTrialId: { [t.trialId]: [r] },
    });

    const proven: CapabilityKey[] = [
      "streaming",
      "toolUse",
      "fileEditing",
      "reportsCost",
      "reportsTokens",
    ];
    for (const key of proven) {
      expect(matrix[key].state).toBe("PROVEN");
      expect(["trial", "receipt"]).toContain(matrix[key].evidence.source);
    }
    expect(matrix.modelSelection.state).toBe("UNSUPPORTED");
    expect(matrix.shellExecution.state).toBe("UNSUPPORTED");
  });

  it("setup failures mark claimed capabilities as blocked by config", () => {
    const blocked = trial({
      agentId: "aedis",
      adapter: "aedis",
      verdict: "error",
      testCount: 0,
      passCount: 0,
      failCount: 0,
      notes: "setup_failed reason=\"Aedis binary missing\"",
    });
    const matrix = buildCapabilityMatrix(getAdapter("aedis"), { trials: [blocked] });
    expect(matrix.toolUse.state).toBe("BLOCKED_BY_CONFIG");
    expect(matrix.fileEditing.state).toBe("BLOCKED_BY_CONFIG");
    expect(matrix.toolUse.evidence.trialId).toBe(blocked.trialId);
  });
});
