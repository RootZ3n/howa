import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@howa/runner/trial-runner.js";
import type { AgentAdapter } from "@howa/adapters/types.js";
import type { TestPack } from "@howa/packs/types.js";

async function tmpdir(): Promise<string> {
  const d = path.join(os.tmpdir(), `howa-h3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(d, { recursive: true });
  return d;
}

const SECRET = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** Adapter whose health check fails with a reason that embeds a secret. */
function failingHealthAdapter(): AgentAdapter {
  return {
    id: "leaky",
    version: "0.0.1",
    name: "Leaky",
    description: "health check leaks a secret in its reason",
    capabilities: { streaming: false } as never,
    truth: {
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: false,
    },
    async health() {
      return { ok: false, reason: `auth failed using key ${SECRET} at /home/op/.env` };
    },
  } as unknown as AgentAdapter;
}

const trivialPack: TestPack = {
  id: "noop",
  version: "0.0.1",
  title: "noop",
  description: "never runs — preflight fails first",
  tests: [
    {
      id: "noop.x",
      title: "x",
      description: "unused",
      category: "truthfulness",
      severity: "low",
      prompt: () => "hi",
      assert: async () => ({
        testId: "noop.x",
        verdict: "pass",
        severity: "low",
        score: 1,
        reasons: [],
        evidence: [],
      }),
    },
  ],
};

describe("health failure reason is redacted in trial summary (H3)", () => {
  it("redacts a secret in summary.notes", async () => {
    const stateRoot = await tmpdir();
    const summary = await runTrial({
      adapter: failingHealthAdapter(),
      packs: [trivialPack],
      stateRoot,
    });

    expect(summary.verdict).toBe("error");
    expect(summary.notes).toBeDefined();
    expect(summary.notes).not.toContain(SECRET);
    expect(summary.notes).toContain("[REDACTED:anthropic_api_key]");

    // And the persisted summary on disk is redacted too.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(stateRoot, "trials", `${summary.trialId}.json`), "utf8"),
    );
    expect(onDisk.notes).not.toContain(SECRET);

    await fs.rm(stateRoot, { recursive: true, force: true });
  });
});
