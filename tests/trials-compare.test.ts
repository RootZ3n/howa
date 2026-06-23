import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { trialsRouter } from "@howa/api/routes/trials.js";
import { receiptFromTest } from "@howa/receipts/receipt.js";
import { ReceiptStore } from "@howa/receipts/receipt-store.js";
import { compareTrials } from "@howa/trials/compare.js";
import { TrialStore, TRIAL_SCHEMA_VERSION, type TrialSummary } from "@howa/storage/index.js";
import type { Verdict } from "@howa/types.js";

async function tmpdir(): Promise<string> {
  const d = path.join(os.tmpdir(), `howa-compare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

function summary(trialId: string, safety: number, truthfulness: number): TrialSummary {
  return {
    trialId,
    agentId: "test",
    adapter: "test",
    packs: ["safety", "truthfulness"],
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
    verdict: "pass",
    score: {
      passRate: 1,
      perCategory: [
        { category: "safety", value: safety, n: 2, reasons: [] },
        { category: "truthfulness", value: truthfulness, n: 1, reasons: [] },
      ],
      costEfficiency: { category: "overall", value: 1, n: 1, reasons: [] },
      trust: safety,
      reasons: [],
      honesty: {
        provisional: false,
        noBehavioralEvidence: false,
        allBehavioralFailed: false,
        costExcludedFromTrust: false,
        noBehavioralCategories: false,
        behavioralN: 3,
        provisionalThreshold: 8,
      },
    },
    testCount: 3,
    passCount: 3,
    failCount: 0,
    velumDecision: "allow",
    howaVersion: "test",
    gitCommit: "test",
    adapterVersion: "test",
    packVersions: {},
    adapterTruth: {
      modelIdentity: "declared",
      costTruth: "reported",
      eventStructure: "structured",
      toolSupport: false,
    },
    schemaVersion: TRIAL_SCHEMA_VERSION,
  };
}

async function saveReceipt(stateRoot: string, trialId: string, testId: string, verdict: Verdict): Promise<void> {
  const store = new ReceiptStore(stateRoot);
  await store.save(
    receiptFromTest({
      trialId,
      testId,
      agentId: "test",
      adapter: "test",
      adapterVersion: "test",
      adapterTruth: {
        modelIdentity: "declared",
        costTruth: "reported",
        eventStructure: "structured",
        toolSupport: false,
      },
      packId: testId.startsWith("safety") ? "safety" : "truthfulness",
      packVersion: "test",
      howaVersion: "test",
      gitCommit: "test",
      prompt: "p",
      expectedBehavior: "e",
      modelInfo: { model: "m", provider: "p", location: "local" },
      costInfo: { reported: true, estimatedCostUsd: 0 },
      events: [],
      artifacts: [],
      stdout: "",
      stderr: "",
      result: {
        testId,
        verdict,
        severity: "low",
        score: verdict === "pass" ? 1 : 0,
        reasons: [],
        evidence: [],
        ...(verdict === "fail" ? { failureType: "wrong_output" as const } : {}),
      },
      velum: { findings: [], decision: "allow", agentDecision: "allow", safeText: "" },
      startedAt: 0,
      finishedAt: 1,
    }),
  );
}

async function seedComparedTrials(stateRoot: string): Promise<void> {
  const trials = new TrialStore(stateRoot);
  await trials.saveTrial(summary("base-001", 1, 1));
  await trials.saveTrial(summary("candidate-001", 0.5, 1));
  await saveReceipt(stateRoot, "base-001", "safety.injection", "pass");
  await saveReceipt(stateRoot, "base-001", "safety.secret", "pass");
  await saveReceipt(stateRoot, "base-001", "truth.answer", "fail");
  await saveReceipt(stateRoot, "candidate-001", "safety.injection", "fail");
  await saveReceipt(stateRoot, "candidate-001", "safety.secret", "warn");
  await saveReceipt(stateRoot, "candidate-001", "truth.answer", "pass");
}

async function invokeCompareRoute(
  stateRoot: string,
  query: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const router = trialsRouter(stateRoot) as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown }>;
      };
    }>;
  };
  const compareIndex = router.stack.findIndex((layer) => layer.route?.path === "/compare");
  const idIndex = router.stack.findIndex((layer) => layer.route?.path === "/:id");
  expect(compareIndex).toBeGreaterThanOrEqual(0);
  expect(idIndex).toBeGreaterThan(compareIndex);
  const handler = router.stack[compareIndex]?.route?.stack[0]?.handle;
  if (!handler) throw new Error("compare route handler missing");

  let status = 200;
  let body: unknown;
  await handler(
    { query },
    {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    },
    (err?: unknown) => {
      if (err) throw err;
    },
  );
  return { status, body };
}

describe("trial comparison", () => {
  it("diffs categories, test verdicts, and pass-to-fail/warn regressions", async () => {
    const stateRoot = await tmpdir();
    await seedComparedTrials(stateRoot);

    const comparison = await compareTrials(stateRoot, "base-001", "candidate-001");
    expect(comparison.base.trialId).toBe("base-001");
    expect(comparison.candidate.trialId).toBe("candidate-001");
    expect(comparison.categoryDiffs).toContainEqual({
      category: "safety",
      baseValue: 1,
      candidateValue: 0.5,
      delta: -0.5,
      baseN: 2,
      candidateN: 2,
    });
    expect(comparison.testDiffs).toEqual([
      {
        testId: "safety.injection",
        packId: "safety",
        baseVerdict: "pass",
        candidateVerdict: "fail",
        changed: true,
      },
      {
        testId: "safety.secret",
        packId: "safety",
        baseVerdict: "pass",
        candidateVerdict: "warn",
        changed: true,
      },
      {
        testId: "truth.answer",
        packId: "truthfulness",
        baseVerdict: "fail",
        candidateVerdict: "pass",
        changed: true,
      },
    ]);
    expect(comparison.regressions.map((r) => r.testId)).toEqual([
      "safety.injection",
      "safety.secret",
    ]);
  });

  it("serves GET /api/trials/compare before the trial id route", async () => {
    const stateRoot = await tmpdir();
    await seedComparedTrials(stateRoot);
    const res = await invokeCompareRoute(stateRoot, {
      base: "base-001",
      candidate: "candidate-001",
    });
    expect(res.status).toBe(200);
    const body = res.body as { regressions: Array<{ testId: string }> };
    expect(body.regressions.map((r) => r.testId)).toEqual([
      "safety.injection",
      "safety.secret",
    ]);
  });

  it("returns 400 for missing compare query parameters", async () => {
    const stateRoot = await tmpdir();
    const res = await invokeCompareRoute(stateRoot, { base: "base-001" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "base and candidate query parameters are required",
    });
  });
});
