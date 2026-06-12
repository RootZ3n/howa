import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { trialsRouter } from "@howa/api/routes/trials.js";
import { TrialStore, TRIAL_SCHEMA_VERSION } from "@howa/storage/index.js";

async function tmpdir(): Promise<string> {
  const d = path.join(os.tmpdir(), `howa-del-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

async function startApp(stateRoot: string) {
  const app = express();
  app.use(express.json());
  app.use("/api/trials", trialsRouter(stateRoot));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind tcp");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe("DELETE /api/trials/:id", () => {
  it("returns 204 and removes the trial when it exists", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    // Save a trial so we have something to delete.
    await store.saveTrial({
      trialId: "delme-001",
      agentId: "test",
      adapter: "test",
      packs: ["stamina"],
      startedAt: 1000,
      finishedAt: 2000,
      durationMs: 1000,
      verdict: "pass",
      score: {
        passRate: 1,
        perCategory: [],
        costEfficiency: { category: "overall", value: 1, n: 1, reasons: [] },
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
    });

    // Verify it was saved
    const before = await store.getTrial("delme-001");
    expect(before).not.toBeNull();

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/delme-001`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("content-length")).toBeNull();

      // Verify it's gone from the store
      const after = await store.getTrial("delme-001");
      expect(after).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the trial does not exist", async () => {
    const stateRoot = await tmpdir();
    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("no such trial");
    } finally {
      await app.close();
    }
  });

  it("removes trial events along with the summary", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({
      trialId: "delme-events",
      agentId: "test",
      adapter: "test",
      packs: ["stamina"],
      startedAt: 1000,
      finishedAt: 2000,
      durationMs: 1000,
      verdict: "pass",
      score: {
        passRate: 1,
        perCategory: [],
        costEfficiency: { category: "overall", value: 1, n: 1, reasons: [] },
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
    });
    // Save some events
    await store.saveTrialEvents("delme-events", [
      { sequence: 1, trialId: "delme-events", timestamp: 1000, phase: "starting", severity: "info", message: "start", adapter: { id: "test", version: "1" }, source: "runner", mode: "buffered" },
    ]);

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/delme-events`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);

      // Both files should be gone
      const eventsAfter = await store.getTrialEvents("delme-events");
      expect(eventsAfter).toEqual([]);
      const summaryAfter = await store.getTrial("delme-events");
      expect(summaryAfter).toBeNull();
    } finally {
      await app.close();
    }
  });
});
