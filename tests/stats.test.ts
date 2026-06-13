import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { statsRouter } from "@howa/api/routes/stats.js";
import { TrialStore, TRIAL_SCHEMA_VERSION } from "@howa/storage/index.js";

async function tmpdir(): Promise<string> {
  const d = path.join(os.tmpdir(), `howa-stats-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

async function startApp(stateRoot: string) {
  const app = express();
  app.use(express.json());
  app.use("/api/stats", statsRouter(stateRoot));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind tcp");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

const BASE_TRIAL = {
  agentId: "test",
  adapter: "test",
  packs: ["stamina"],
  startedAt: 1000,
  finishedAt: 2000,
  durationMs: 1000,
  verdict: "pass" as const,
  score: {
    passRate: 1,
    perCategory: [],
    costEfficiency: { category: "overall" as const, value: 1, n: 1, reasons: [] },
    trust: 1,
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
  velumDecision: "allow" as const,
  howaVersion: "test",
  gitCommit: "test",
  adapterVersion: "test",
  packVersions: {},
  adapterTruth: {
    modelIdentity: "declared" as const,
    costTruth: "reported" as const,
    eventStructure: "structured" as const,
    toolSupport: false,
  },
  schemaVersion: TRIAL_SCHEMA_VERSION,
};

describe("GET /api/stats", () => {
  it("returns zeros when the store is empty", async () => {
    const stateRoot = await tmpdir();
    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/stats`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, number>;
      expect(data.totalTrials).toBe(0);
      expect(data.completedTrials).toBe(0);
      expect(data.averageDurationMs).toBe(0);
      expect(data.uniqueTargets).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns correct counts with some trials", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({ ...BASE_TRIAL, trialId: "t1", agentId: "agent-a", verdict: "pass" });
    await store.saveTrial({ ...BASE_TRIAL, trialId: "t2", agentId: "agent-b", verdict: "fail" });
    await store.saveTrial({ ...BASE_TRIAL, trialId: "t3", agentId: "agent-a", verdict: "error" });

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/stats`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, number>;
      expect(data.totalTrials).toBe(3);
      expect(data.completedTrials).toBe(1);
      expect(data.uniqueTargets).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("computes average duration of completed trials correctly", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({ ...BASE_TRIAL, trialId: "d1", durationMs: 200, verdict: "pass" });
    await store.saveTrial({ ...BASE_TRIAL, trialId: "d2", durationMs: 600, verdict: "pass" });
    await store.saveTrial({ ...BASE_TRIAL, trialId: "d3", durationMs: 999, verdict: "fail" });

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/stats`);
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, number>;
      expect(data.completedTrials).toBe(2);
      expect(data.averageDurationMs).toBe(400);
    } finally {
      await app.close();
    }
  });
});
