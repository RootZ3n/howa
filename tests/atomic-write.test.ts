import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@howa/utils/atomic-write.js";
import { ReceiptStore } from "@howa/receipts/receipt-store.js";
import { receiptFromTest } from "@howa/receipts/receipt.js";
import { TrialStore } from "@howa/storage/index.js";
import type { Receipt } from "@howa/receipts/receipt.js";
import type { TrialSummary } from "@howa/storage/index.js";
import type { AdapterTruthContract } from "@howa/adapters/types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "howa-atomic-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function listTmpFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".tmp")) found.push(full);
    }
  }
  await walk(root);
  return found;
}

describe("writeFileAtomic (C3)", () => {
  it("writes content correctly and leaves no .tmp file", async () => {
    const file = path.join(dir, "nested", "out.json");
    await writeFileAtomic(file, JSON.stringify({ a: 1 }));
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ a: 1 });
    expect(await listTmpFiles(dir)).toEqual([]);
  });

  it("serializes non-string data", async () => {
    const file = path.join(dir, "obj.json");
    await writeFileAtomic(file, { hello: "world" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ hello: "world" });
  });

  it("overwrites an existing file atomically", async () => {
    const file = path.join(dir, "x.txt");
    await writeFileAtomic(file, "first");
    await writeFileAtomic(file, "second");
    expect(await fs.readFile(file, "utf8")).toBe("second");
    expect(await listTmpFiles(dir)).toEqual([]);
  });
});

describe("persistence layers use atomic writes (C3)", () => {
  const truth: AdapterTruthContract = {
    modelIdentity: "declared",
    costTruth: "reported",
    eventStructure: "structured",
    toolSupport: true,
  };

  const baseReceipt = (): Receipt =>
    receiptFromTest({
      trialId: "trial-1",
      testId: "pack.test",
      agentId: "mock",
      adapter: "mock",
      adapterVersion: "0.1.0",
      adapterTruth: truth,
      packId: "truthfulness",
      packVersion: "1.0.0",
      howaVersion: "0.1.0",
      gitCommit: "abcdef012345",
      prompt: "do the thing",
      expectedBehavior: "produce a file",
      modelInfo: { model: "m", provider: "p", location: "local" },
      costInfo: { reported: true, estimatedCostUsd: 0, totalTokens: 12 },
      events: [],
      artifacts: [],
      stdout: "",
      stderr: "",
      result: {
        testId: "pack.test",
        verdict: "pass",
        severity: "low",
        score: 1,
        reasons: ["ok"],
        evidence: [],
      },
      velum: { findings: [], decision: "allow", agentDecision: "allow", safeText: "" },
      startedAt: 0,
      finishedAt: 1,
    });

  it("ReceiptStore.save leaves no .tmp and writes valid JSON", async () => {
    const store = new ReceiptStore(dir);
    const { jsonPath } = await store.save(baseReceipt());
    const parsed = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    expect(parsed.testId).toBe("pack.test");
    expect(await listTmpFiles(dir)).toEqual([]);
  });

  it("TrialStore.saveTrial and saveTrialEvents leave no .tmp", async () => {
    const store = new TrialStore(dir);
    const summary = { trialId: "trial-1", startedAt: 1 } as unknown as TrialSummary;
    const file = await store.saveTrial(summary);
    expect(JSON.parse(await fs.readFile(file, "utf8")).trialId).toBe("trial-1");

    const eventsFile = await store.saveTrialEvents("trial-1", [
      { sequence: 1, trialId: "trial-1", timestamp: 1, phase: "starting" } as never,
    ]);
    expect(JSON.parse(await fs.readFile(eventsFile, "utf8"))).toHaveLength(1);

    expect(await listTmpFiles(dir)).toEqual([]);
  });
});
