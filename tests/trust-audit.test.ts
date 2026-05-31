import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@colosseum/runner/trial-runner.js";
import { createMockAdapter } from "@colosseum/adapters/mock.js";
import { listPacks, getPack } from "@colosseum/packs/registry.js";
import {
  aggregate,
  scorePack,
  PROVISIONAL_SAMPLE_THRESHOLD,
} from "@colosseum/scoring/score.js";
import {
  hasObservableBehavior,
  noEvidenceResult,
} from "@colosseum/packs/no-evidence.js";
import type { TestPack, TestResult, TestCategory } from "@colosseum/packs/types.js";
import type { AgentAdapter } from "@colosseum/adapters/types.js";

/**
 * Regression coverage for the bugs identified in the pre-release trust
 * audit. Each describe-block names a specific Crucible-class trust failure
 * the audit found and the test pins the now-correct behavior.
 */

async function tmpdir(prefix: string): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `colosseum-trust-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

/**
 * A "silent agent" adapter — exits cleanly with NO output, NO stdout, NO
 * stderr, NO events, NO artifacts. It declares model identity truthfully
 * so detectInfrastructureFailure cannot catch it. This is the worst-case
 * shape that the pre-fix scoring rewarded with ~66% trust.
 */
function createSilentAdapter(): AgentAdapter {
  return {
    id: "silent-test",
    version: "0.0.1",
    name: "Silent Test Agent",
    description: "Returns empty output but exits cleanly. Audit-fixture.",
    capabilities: {
      streaming: false,
      toolUse: false,
      fileEditing: false,
      shellExecution: false,
      modelSelection: false,
      reportsCost: false,
      reportsTokens: false,
    },
    truth: {
      modelIdentity: "declared",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: false,
    },
    async health() {
      return { ok: true };
    },
    async startSession(opts) {
      return {
        sessionId: `silent-${Math.random()}`,
        workspace: opts.workspace,
        modelInfo: {
          model: "silent-1",
          provider: "silent-test",
          location: "local",
        },
      };
    },
    async sendPrompt() {
      return {
        events: [],
        artifacts: [],
        exitCode: 0,
        modelInfo: {
          model: "silent-1",
          provider: "silent-test",
          location: "local",
        },
        costInfo: { reported: false, note: "silent agent" },
        durationMs: 1,
        stdout: "",
        stderr: "",
        finalAnswer: undefined,
      };
    },
    async stop() {},
    async collectArtifacts() {
      return [];
    },
    async getModelInfo() {
      return { model: "silent-1", provider: "silent-test", location: "local" };
    },
    async getCostInfo() {
      return { reported: false };
    },
  };
}

describe("trust audit: silent-agent inflation (Crucible-class)", () => {
  it("hasObservableBehavior is false when there is no answer/stdout/events/artifacts", () => {
    // Note the absence of any `stderr` arg — the detector intentionally
    // excludes stderr from "behavior" because a bare stderr spew with
    // zero stdout/answer/events is the infrastructure-failure pattern,
    // not the agent demonstrating behavior.
    expect(
      hasObservableBehavior({
        finalAnswer: undefined,
        stdout: "",
        events: [],
        artifacts: [],
      }),
    ).toBe(false);
  });

  it("hasObservableBehavior is true when any one of the four signals is present", () => {
    expect(hasObservableBehavior({ finalAnswer: "hi" })).toBe(true);
    expect(hasObservableBehavior({ stdout: "hi" })).toBe(true);
    expect(hasObservableBehavior({ events: [{ kind: "thought", text: "x" }] })).toBe(
      true,
    );
    expect(hasObservableBehavior({ artifacts: [{ path: "x", bytes: 1 }] })).toBe(true);
  });

  it("noEvidenceResult returns warn with zero score and no_evidence type", () => {
    const r = noEvidenceResult({ id: "demo.test", severity: "high" });
    expect(r.verdict).toBe("warn");
    expect(r.score).toBe(0);
    expect(r.failureType).toBe("no_evidence");
  });

  it("silent agent earns no behavioral credit and is flagged no-evidence + provisional", async () => {
    const stateRoot = await tmpdir("silent");
    const summary = await runTrial({
      adapter: createSilentAdapter(),
      packs: listPacks(),
      stateRoot,
    });

    // Pre-fix this trial scored ~66% trust because safety/local-model
    // judges treated absence-of-bad-output as evidence of safe behavior.
    // Post-fix it must be near zero (the only legitimate pass is
    // repo.clean-on-failure which expects no-op).
    expect(summary.score.trust).toBeLessThanOrEqual(0.1);
    expect(summary.passCount).toBeLessThanOrEqual(1);

    // Honesty stamps must surface that silence is not authoritative
    // evidence. The bundled `repo.clean-on-failure` test legitimately
    // expects no-op so silent agents get exactly one true pass; that
    // means `noBehavioralEvidence` and `allBehavioralFailed` may both be
    // false, but the trust score (asserted above) is still bounded near
    // zero, which is the actual fix. Verify the honesty block is at
    // least populated and the behavioral n is realistic.
    expect(summary.honesty).toBeDefined();
    expect(summary.honesty?.behavioralN).toBeGreaterThan(0);

    // Receipts include no_evidence warns, not silent passes.
    const dir = path.join(stateRoot, "receipts", summary.trialId);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    let sawNoEvidence = false;
    for (const f of files) {
      const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as {
        verdict: string;
        failureType?: string;
      };
      if (r.failureType === "no_evidence") sawNoEvidence = true;
    }
    expect(sawNoEvidence).toBe(true);
  });
});

describe("trust audit: cost cannot purchase trust on its own (Crucible-class)", () => {
  function r(
    verdict: TestResult["verdict"],
    score: number,
    severity: TestResult["severity"] = "low",
    testId = "x",
  ): TestResult {
    return { testId, verdict, severity, score, reasons: [], evidence: [] };
  }

  it("when every behavioral category averages zero, cost-efficiency is excluded from trust", () => {
    const byCategory: Record<TestCategory, TestResult[]> = {
      truthfulness: [r("fail", 0)],
      "repo-editing": [r("fail", 0)],
      safety: [r("fail", 0, "high")],
      stamina: [r("fail", 0)],
      "local-model": [r("fail", 0)],
      "tool-calling": [],
      "context-stamina": [],
    };
    const out = aggregate({
      byCategory,
      // Reported cost — under $0.01 → cost-efficiency would be 1.0 if
      // it contributed.
      costs: [{ reported: true, estimatedCostUsd: 0.001 }],
    });
    // Trust must be exactly zero — cost cannot lift it.
    expect(out.trust).toBe(0);
    expect(out.honesty.costExcludedFromTrust).toBe(true);
    expect(out.honesty.allBehavioralFailed).toBe(true);
    expect(out.reasons.some((x) => x.includes("withheld from trust"))).toBe(true);
  });

  it("when behavioral correctness is non-zero, cost still contributes", () => {
    const byCategory: Record<TestCategory, TestResult[]> = {
      truthfulness: [r("pass", 1)],
      "repo-editing": [r("pass", 1)],
      safety: [r("pass", 1, "high")],
      stamina: [r("pass", 1)],
      "local-model": [r("pass", 1)],
      "tool-calling": [],
      "context-stamina": [],
    };
    const out = aggregate({
      byCategory,
      costs: [{ reported: true, estimatedCostUsd: 0.001 }],
    });
    expect(out.trust).toBe(1);
    expect(out.honesty.costExcludedFromTrust).toBe(false);
  });

  it("missing/unreported cost stays neutral and does not appear in trust math", () => {
    const byCategory: Record<TestCategory, TestResult[]> = {
      truthfulness: [r("pass", 1)],
      "repo-editing": [],
      safety: [],
      stamina: [],
      "local-model": [],
      "tool-calling": [],
      "context-stamina": [],
    };
    const out = aggregate({ byCategory, costs: [{ reported: false }] });
    // Only truthfulness contributed. Trust = 1.0 because cost.n === 0
    // and is therefore not in the weighted sum.
    expect(out.trust).toBe(1);
    expect(out.honesty.costExcludedFromTrust).toBe(false);
  });
});

describe("trust audit: provisional / small-sample flag", () => {
  function r(testId = "x"): TestResult {
    return {
      testId,
      verdict: "pass",
      severity: "low",
      score: 1,
      reasons: [],
      evidence: [],
    };
  }

  it("flags provisional when behavioral n < threshold", () => {
    const byCategory: Record<TestCategory, TestResult[]> = {
      truthfulness: [r("a"), r("b")],
      "repo-editing": [r("c")],
      safety: [],
      stamina: [],
      "local-model": [],
      "tool-calling": [],
      "context-stamina": [],
    };
    const out = aggregate({ byCategory, costs: [] });
    expect(out.honesty.behavioralN).toBe(3);
    expect(out.honesty.behavioralN).toBeLessThan(PROVISIONAL_SAMPLE_THRESHOLD);
    expect(out.honesty.provisional).toBe(true);
  });

  it("does NOT flag provisional when behavioral n meets the threshold", () => {
    const byCategory: Record<TestCategory, TestResult[]> = {
      truthfulness: [r("a"), r("b"), r("c"), r("d")],
      "repo-editing": [r("e"), r("f"), r("g"), r("h")],
      safety: [],
      stamina: [],
      "local-model": [],
      "tool-calling": [],
      "context-stamina": [],
    };
    const out = aggregate({ byCategory, costs: [] });
    expect(out.honesty.behavioralN).toBe(8);
    expect(out.honesty.provisional).toBe(false);
  });
});

describe("trust audit: skipped tests no longer credit 0.5", () => {
  it("a skipped result without an explicit score scores 0, not 0.5", () => {
    const sp = scorePack(
      [
        {
          testId: "x",
          verdict: "skipped",
          severity: "low",
          score: undefined as unknown as number,
          reasons: [],
          evidence: [],
        },
      ],
      "stamina",
    );
    expect(sp.value).toBe(0);
  });
});

describe("trust audit: mock-trial flag travels with the summary", () => {
  it("mock adapter trial is stamped isMockTrial=true on the summary", async () => {
    const stateRoot = await tmpdir("mockflag");
    const summary = await runTrial({
      adapter: createMockAdapter(),
      packs: [getPack("local-model")],
      stateRoot,
    });
    expect(summary.isMockTrial).toBe(true);
    expect(summary.honesty).toBeDefined();
    expect(summary.schemaVersion).toBeGreaterThanOrEqual(2);
  });
});

describe("trust audit: every pack defines unique, well-formed test ids", () => {
  it("test ids are unique across all packs", () => {
    const seen = new Set<string>();
    for (const pack of listPacks()) {
      for (const t of pack.tests) {
        expect(seen.has(t.id), `duplicate test id ${t.id}`).toBe(false);
        seen.add(t.id);
      }
    }
  });

  it("every test has a non-empty prompt and a category", async () => {
    for (const pack of listPacks()) {
      for (const t of pack.tests) {
        const prompt = await t.prompt({
          workspace: "/tmp/audit-noop",
          fixtureRoot: "/tmp/audit-noop",
        } as never);
        expect(prompt.length, `${t.id} prompt empty`).toBeGreaterThan(0);
        expect(t.category).toBeDefined();
      }
    }
  });
});

describe("trust audit: fail receipt failureType taxonomy includes no_evidence", () => {
  it("no_evidence is part of the FailureType union (compile-time + runtime)", async () => {
    const stateRoot = await tmpdir("ne-taxon");
    const summary = await runTrial({
      adapter: createSilentAdapter(),
      packs: [getPack("safety")],
      stateRoot,
    });
    const dir = path.join(stateRoot, "receipts", summary.trialId);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const types = new Set<string>();
    for (const f of files) {
      const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as {
        failureType?: string;
      };
      if (r.failureType) types.add(r.failureType);
    }
    expect(types.has("no_evidence")).toBe(true);
  });
});

describe("trust audit: preflight receipt marks diff unavailable, not unchanged", () => {
  it("a preflight-failed adapter produces a receipt with repoDiffStatus=unavailable", async () => {
    const stateRoot = await tmpdir("preflight");
    // Build a tiny adapter whose health check fails.
    const sickAdapter: AgentAdapter = {
      ...createSilentAdapter(),
      id: "sick",
      async health() {
        return { ok: false, reason: "test: deliberate preflight failure" };
      },
    };
    const summary = await runTrial({
      adapter: sickAdapter,
      packs: [getPack("truthfulness")],
      stateRoot,
    });
    expect(summary.verdict).toBe("error");
    const dir = path.join(stateRoot, "receipts", summary.trialId);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const r = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8")) as {
      repoDiffStatus?: string;
      repoDiffUnavailableReason?: string;
    };
    expect(r.repoDiffStatus).toBe("unavailable");
    expect(r.repoDiffUnavailableReason).toBeDefined();
  });
});
