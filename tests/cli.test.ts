import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { receiptFromTest } from "@howa/receipts/receipt.js";
import { ReceiptStore } from "@howa/receipts/receipt-store.js";
import { TrialStore, TRIAL_SCHEMA_VERSION, type TrialSummary } from "@howa/storage/index.js";
import type { Verdict } from "@howa/types.js";

const cliEntry = path.resolve(__dirname, "../src/cli/index.ts");
const tsxLoader = path.resolve(__dirname, "../node_modules/tsx/dist/loader.mjs");

function runCli(
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string; input?: string } = {},
) {
  const r = spawnSync(
    "node",
    ["--import", tsxLoader, cliEntry, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd: options.cwd,
      input: options.input,
    },
  );
  return r;
}

function summary(trialId: string, safety: number): TrialSummary {
  return {
    trialId,
    agentId: "test",
    adapter: "test",
    packs: ["safety"],
    startedAt: 1000,
    finishedAt: 2000,
    durationMs: 1000,
    verdict: "pass",
    score: {
      passRate: 1,
      perCategory: [{ category: "safety", value: safety, n: 1, reasons: [] }],
      costEfficiency: { category: "overall", value: 1, n: 1, reasons: [] },
      trust: safety,
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
    passCount: 1,
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

async function saveReceipt(stateRoot: string, trialId: string, verdict: Verdict): Promise<void> {
  await new ReceiptStore(stateRoot).save(
    receiptFromTest({
      trialId,
      testId: "safety.injection",
      agentId: "test",
      adapter: "test",
      adapterVersion: "test",
      adapterTruth: {
        modelIdentity: "declared",
        costTruth: "reported",
        eventStructure: "structured",
        toolSupport: false,
      },
      packId: "safety",
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
        testId: "safety.injection",
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

describe("CLI", () => {
  it("`list agents` prints registered adapters", () => {
    const r = runCli(["list", "agents"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mock/);
    expect(r.stdout).toMatch(/aedis/);
  });

  it("`list packs` prints the five packs", () => {
    const r = runCli(["list", "packs"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Truthfulness/);
    expect(r.stdout).toMatch(/Safety/);
  });

  it("`run --agent mock` exits 0 for a passing trial", async () => {
    const stateRoot = path.join(
      os.tmpdir(),
      `howa-cli-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const r = runCli([
      "run",
      "--agent",
      "mock",
      "--pack",
      "stamina",
      "--state",
      stateRoot,
      "--quiet",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Trial trial-/);
    expect(r.stdout).toMatch(/— PASS/);
    const trialsDir = path.join(stateRoot, "trials");
    const entries = await fs.readdir(trialsDir);
    expect(entries.length).toBeGreaterThan(0);
  }, 30_000);

  it("`run --explain` prints honesty stamp explanations", () => {
    const stateRoot = path.join(
      os.tmpdir(),
      `howa-cli-explain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const r = runCli([
      "run",
      "--agent",
      "mock",
      "--pack",
      "stamina",
      "--state",
      stateRoot,
      "--quiet",
      "--explain",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/honesty=MOCK\/DEMO,PROVISIONAL/);
    expect(r.stdout).toContain(
      "PROVISIONAL: Score based on partial data — some checks were skipped",
    );
  }, 30_000);

  it("`init` writes howa.config.json and verifies setup with a mock trial", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `howa-cli-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const binDir = path.join(cwd, "bin");
    const home = path.join(cwd, "home");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    const fakeAedis = path.join(binDir, "aedis");
    await fs.writeFile(fakeAedis, "#!/bin/sh\necho aedis\n", { mode: 0o755 });

    const r = runCli(
      ["init"],
      {
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      { cwd },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote");
    expect(r.stdout).toContain("aedis");
    expect(r.stdout).toMatch(/Mock trial trial-.* — PASS/);

    const config = JSON.parse(await fs.readFile(path.join(cwd, "howa.config.json"), "utf8"));
    expect(config.stateRoot).toBe(path.join(home, ".howa"));
    expect(config.agents.aedis).toEqual({
      adapter: "aedis",
      binary: fakeAedis,
      env: "AEDIS_BIN",
    });
    const trials = await fs.readdir(path.join(home, ".howa", "trials"));
    expect(trials.length).toBeGreaterThan(0);
  }, 30_000);

  it("`run --agent mock` exits nonzero for a failing trial", () => {
    const stateRoot = path.join(
      os.tmpdir(),
      `howa-cli-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const r = runCli([
      "run",
      "--agent",
      "mock",
      "--pack",
      "truthfulness",
      "--state",
      stateRoot,
      "--quiet",
    ]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/— FAIL/);
  }, 30_000);

  it("`run` exits nonzero for an adapter setup error", () => {
    const stateRoot = path.join(
      os.tmpdir(),
      `howa-cli-error-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const r = runCli([
      "run",
      "--agent",
      "aedis",
      "--pack",
      "truthfulness",
      "--state",
      stateRoot,
      "--quiet",
    ], { AEDIS_BIN: "__howa_missing_aedis_binary__" });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/Adapter setup failed/);
    expect(r.stdout).toMatch(/— ERROR/);
  }, 30_000);

  it("`compare` prints category, verdict, and regression diffs", async () => {
    const stateRoot = path.join(
      os.tmpdir(),
      `howa-cli-compare-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const trials = new TrialStore(stateRoot);
    await trials.saveTrial(summary("base-cli", 1));
    await trials.saveTrial(summary("candidate-cli", 0));
    await saveReceipt(stateRoot, "base-cli", "pass");
    await saveReceipt(stateRoot, "candidate-cli", "fail");

    const r = runCli(["compare", "base-cli", "candidate-cli", "--state", stateRoot]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Trial comparison");
    expect(r.stdout).toContain("safety.injection");
    expect(r.stdout).toContain("PASS → FAIL");
    expect(r.stdout).toContain("regressions=1");
  });
});
