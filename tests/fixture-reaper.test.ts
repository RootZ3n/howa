import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FixtureManager } from "@howa/runner/fixture-manager.js";

let root: string;

/** Create a workspace dir with a file and backdate its mtime by `ageDays`. */
async function makeFixture(trialId: string, ws: string, ageDays: number): Promise<string> {
  const dir = path.join(root, "fixtures", trialId, ws);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "output.txt"), "x".repeat(100));
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  await fs.utimes(dir, when, when);
  return dir;
}

describe("reapStaleFixtures (H1)", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "howa-reaper-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("dry run reports stale fixtures without deleting", async () => {
    const stale = await makeFixture("trial-old", "test.a-aaaaaa", 30);
    const fresh = await makeFixture("trial-new", "test.b-bbbbbb", 1);

    const fm = new FixtureManager(root);
    const plan = await fm.reapStaleFixtures(7, { dryRun: true });

    expect(plan.scanned).toBe(2);
    expect(plan.wouldDelete.map((c) => c.path)).toEqual([stale]);
    expect(plan.wouldFreeBytes).toBeGreaterThan(0);
    // Nothing actually removed.
    expect(await fs.stat(stale)).toBeTruthy();
    expect(await fs.stat(fresh)).toBeTruthy();
  });

  it("actually deletes stale fixtures and preserves fresh ones", async () => {
    const stale = await makeFixture("trial-old", "test.a-aaaaaa", 30);
    const fresh = await makeFixture("trial-new", "test.b-bbbbbb", 1);

    const fm = new FixtureManager(root);
    const result = await fm.reapStaleFixtures(7, { dryRun: false });

    expect(result.wouldDelete.map((c) => c.path)).toEqual([stale]);
    await expect(fs.stat(stale)).rejects.toThrow();
    // Emptied trial dir is removed too.
    await expect(fs.stat(path.join(root, "fixtures", "trial-old"))).rejects.toThrow();
    // Fresh fixture survives.
    expect(await fs.stat(fresh)).toBeTruthy();
  });

  it("returns empty result when fixtures dir is absent", async () => {
    const fm = new FixtureManager(path.join(root, "does-not-exist"));
    const result = await fm.reapStaleFixtures(7, { dryRun: false });
    expect(result.scanned).toBe(0);
    expect(result.wouldDelete).toEqual([]);
  });
});

describe("admin cleanup endpoints (H1/M3)", () => {
  let server: http.Server;
  let baseUrl: string;
  let endpointRoot: string;

  async function req(
    method: string,
    p: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const r = http.request(
        new URL(p, baseUrl),
        {
          method,
          headers: data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {},
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, json: buf ? JSON.parse(buf) : null }),
          );
        },
      );
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
  }

  beforeAll(async () => {
    endpointRoot = await fs.mkdtemp(path.join(os.tmpdir(), "howa-admin-"));
    process.env.HOWA_STATE_ROOT = endpointRoot;
    // Seed one stale fixture under the server's state root.
    const dir = path.join(endpointRoot, "fixtures", "trial-old", "test.a-aaaaaa");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "f.txt"), "y".repeat(50));
    const when = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(dir, when, when);

    // Import after HOWA_STATE_ROOT is set so the module resolves this root.
    const { buildApp } = await import("@howa/api/server.js");
    const app = await buildApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(endpointRoot, { recursive: true, force: true });
    delete process.env.HOWA_STATE_ROOT;
  });

  it("GET /api/admin/cleanup is a dry run", async () => {
    const res = await req("GET", "/api/admin/cleanup");
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(true);
    expect(res.json.wouldDelete.length).toBe(1);
    expect(res.json.wouldFreeBytes).toBeGreaterThan(0);
    // Still on disk.
    expect(
      await fs.stat(path.join(endpointRoot, "fixtures", "trial-old", "test.a-aaaaaa")),
    ).toBeTruthy();
  });

  it("POST /api/admin/cleanup without confirm is rejected", async () => {
    const res = await req("POST", "/api/admin/cleanup", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/admin/cleanup with confirm deletes", async () => {
    const res = await req("POST", "/api/admin/cleanup", { confirm: true });
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(false);
    expect(res.json.deleted.length).toBe(1);
    await expect(
      fs.stat(path.join(endpointRoot, "fixtures", "trial-old", "test.a-aaaaaa")),
    ).rejects.toThrow();
  });

  it("GET /api/admin/logs returns entries array", async () => {
    const res = await req("GET", "/api/admin/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.entries)).toBe(true);
  });
});
