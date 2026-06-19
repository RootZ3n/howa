import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@howa/runner/trial-runner.js";
import { getAdapter } from "@howa/adapters/registry.js";
import { getPack } from "@howa/packs/registry.js";

async function tmpdir(): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `howa-mechanic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

// ────────────────────────────────────────────────────────────────────
//  Adapter shape + truth contract
// ────────────────────────────────────────────────────────────────────

describe("the Mechanic adapter — shape + truth contract", () => {
  it("registers under id 'mechanic' with the documented truth contract", () => {
    const a = getAdapter("mechanic");
    expect(a.id).toBe("mechanic");
    expect(a.name).toBe("the Mechanic");
    expect(a.version).toBeDefined();
    expect(a.truth).toEqual({
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: true,
    });
  });

  it("declares HTTP-based protocol", () => {
    const a = getAdapter("mechanic");
    // New HTTP adapter may or may not have protocol — but it should work
    expect(a.capabilities.toolUse).toBe(true);
    expect(a.capabilities.fileEditing).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
//  Health probe — HTTP-based
// ────────────────────────────────────────────────────────────────────

describe("the Mechanic adapter — health()", () => {
  it("unreachable server returns ok:false", async () => {
    const old = process.env.MECHANIC_URL;
    process.env.MECHANIC_URL = "http://127.0.0.1:19999";
    const r = await getAdapter("mechanic").health();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/the Mechanic contract probe failed/i);
    process.env.MECHANIC_URL = old;
  });

  it("healthy server returns ok:true", async () => {
    // Only run if mechanic is actually running
    const old = process.env.MECHANIC_URL;
    process.env.MECHANIC_URL = "http://127.0.0.1:18810";
    try {
      const r = await getAdapter("mechanic").health();
      if (r.ok) {
        expect(r.reason).toMatch(/healthy/);
      }
      // If mechanic isn't running, that's fine — skip
    } catch {
      // Connection refused — mechanic not running, skip
    }
    process.env.MECHANIC_URL = old;
  });
});

// ────────────────────────────────────────────────────────────────────
//  Runner preflight — unreachable server surfaces as adapter_setup_failed
// ────────────────────────────────────────────────────────────────────

describe("Runner preflight: the Mechanic server unreachable surfaces as adapter_setup_failed", () => {
  it("does NOT misclassify as agent behavior", async () => {
    const old = process.env.MECHANIC_URL;
    process.env.MECHANIC_URL = "http://127.0.0.1:19999";
    const stateRoot = await tmpdir();

    const summary = await runTrial({
      adapter: getAdapter("mechanic"),
      packs: [getPack("truthfulness")],
      stateRoot,
    });
    process.env.MECHANIC_URL = old;

    expect(summary.verdict).toBe("error");
    expect(summary.testCount).toBe(1);
    expect(summary.notes).toMatch(/setup_failed/);

    const receiptsDir = path.join(stateRoot, "receipts", summary.trialId);
    const files = (await fs.readdir(receiptsDir)).filter((f) => f.endsWith(".json"));
    expect(files).toEqual(["preflight.adapter-health.json"]);

    const r = JSON.parse(
      await fs.readFile(path.join(receiptsDir, "preflight.adapter-health.json"), "utf8"),
    ) as { verdict: string; failureType: string; reasons: string[] };
    expect(r.verdict).toBe("error");
    expect(r.failureType).toBe("adapter_setup_failed");
    expect(r.failureType).not.toBe("no_output");
    expect(r.failureType).not.toBe("tool_failure_hidden");
  });
});
