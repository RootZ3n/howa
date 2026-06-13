import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { trialsRouter } from "@howa/api/routes/trials.js";
import { TrialStore, TRIAL_SCHEMA_VERSION } from "@howa/storage/index.js";

async function tmpdir(): Promise<string> {
  const d = path.join(os.tmpdir(), `howa-notes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
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

describe("POST /api/trials/:id/notes", () => {
  it("creates a note and returns 201", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({ ...BASE_TRIAL, trialId: "notes-001" });

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/notes-001/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "first annotation" }),
      });
      expect(res.status).toBe(201);
      const note = await res.json() as { id: string; trialId: string; text: string; createdAt: number };
      expect(note.trialId).toBe("notes-001");
      expect(note.text).toBe("first annotation");
      expect(typeof note.id).toBe("string");
      expect(typeof note.createdAt).toBe("number");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a nonexistent trial", async () => {
    const stateRoot = await tmpdir();
    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/nonexistent/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "should fail" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("no such trial");
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/trials/:id/notes", () => {
  it("returns notes for a trial that has some", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({ ...BASE_TRIAL, trialId: "notes-002" });

    const app = await startApp(stateRoot);
    try {
      await fetch(`${app.baseUrl}/api/trials/notes-002/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "note one" }),
      });
      await fetch(`${app.baseUrl}/api/trials/notes-002/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "note two" }),
      });

      const res = await fetch(`${app.baseUrl}/api/trials/notes-002/notes`);
      expect(res.status).toBe(200);
      const body = await res.json() as { notes: { text: string }[] };
      expect(body.notes).toHaveLength(2);
      expect(body.notes[0].text).toBe("note one");
      expect(body.notes[1].text).toBe("note two");
    } finally {
      await app.close();
    }
  });

  it("returns empty array when trial has no notes", async () => {
    const stateRoot = await tmpdir();
    const store = new TrialStore(stateRoot);
    await store.saveTrial({ ...BASE_TRIAL, trialId: "notes-003" });

    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/notes-003/notes`);
      expect(res.status).toBe(200);
      const body = await res.json() as { notes: unknown[] };
      expect(body.notes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for a nonexistent trial", async () => {
    const stateRoot = await tmpdir();
    const app = await startApp(stateRoot);
    try {
      const res = await fetch(`${app.baseUrl}/api/trials/nonexistent/notes`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe("no such trial");
    } finally {
      await app.close();
    }
  });
});
