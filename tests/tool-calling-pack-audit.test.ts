import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@howa/runner/trial-runner.js";
import { getPack } from "@howa/packs/registry.js";
import {
  detectRepeatLoops,
  hasValidToolCall,
  hasVerificationStep,
} from "@howa/packs/tool-calling/index.js";
import type { AgentAdapter } from "@howa/adapters/types.js";
import type { AgentArtifact, AgentRunResult, ModelInfo } from "@howa/types.js";

async function tmpdir(prefix: string): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `howa-tool-audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

const modelInfo: ModelInfo = {
  model: "tool-audit-model",
  provider: "tool-audit",
  location: "local",
};

function baseRun(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    events: [{ ts: Date.now(), kind: "final", text: "done" }],
    artifacts: [],
    exitCode: 0,
    modelInfo,
    costInfo: { reported: true, estimatedCostUsd: 0, totalTokens: 0 },
    durationMs: 1,
    stdout: "done\n",
    stderr: "",
    finalAnswer: "done",
    ...overrides,
  };
}

async function collect(workspace: string): Promise<AgentArtifact[]> {
  const out: AgentArtifact[] = [];
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir).catch(() => [])) {
      if (entry === ".git") continue;
      const full = path.join(dir, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await walk(full);
      else {
        const rel = path.relative(workspace, full);
        const preview = await fs.readFile(full, "utf8").catch(() => "");
        out.push({ path: rel, bytes: stat.size, preview: preview.slice(0, 256) });
      }
    }
  }
  await walk(workspace);
  return out;
}

function toolAdapter(
  handler: (prompt: string, workspace: string) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>,
): AgentAdapter {
  let workspace = "";
  return {
    id: "tool-audit",
    version: "0.0.1",
    name: "Tool Audit Adapter",
    description: "Deterministic adapter for tool-calling pack audit tests.",
    capabilities: {
      streaming: false,
      toolUse: true,
      fileEditing: true,
      shellExecution: true,
      modelSelection: false,
      reportsCost: true,
      reportsTokens: true,
    },
    truth: {
      modelIdentity: "declared",
      costTruth: "reported",
      eventStructure: "structured",
      toolSupport: true,
    },
    async health() {
      return { ok: true };
    },
    async startSession(opts) {
      workspace = opts.workspace;
      return { sessionId: `tool-${Math.random()}`, workspace, modelInfo };
    },
    async sendPrompt(_handle, prompt) {
      return baseRun(await handler(prompt, workspace));
    },
    async stop() {},
    async collectArtifacts() {
      return collect(workspace);
    },
    async getModelInfo() {
      return modelInfo;
    },
    async getCostInfo() {
      return { reported: true, estimatedCostUsd: 0 };
    },
  };
}

async function readReceipt(stateRoot: string, trialId: string, testId: string) {
  return JSON.parse(
    await fs.readFile(
      path.join(stateRoot, "receipts", trialId, `${testId}.json`),
      "utf8",
    ),
  ) as {
    testId: string;
    verdict: string;
    failureType?: string;
    evaluationCategory?: string;
    reasons: string[];
    observedBehavior: string;
  };
}

// ── Helper unit tests ────────────────────────────────────────────────

describe("tool-calling helpers", () => {
  it("detectRepeatLoops: finds consecutive identical tool calls", () => {
    const events = [
      { kind: "tool_call", text: "rm locked.txt" },
      { kind: "tool_call", text: "rm locked.txt" },
      { kind: "tool_call", text: "rm locked.txt" },
      { kind: "tool_call", text: "ls" },
    ];
    const { maxConsecutive, repeated } = detectRepeatLoops(events);
    expect(maxConsecutive).toBe(3);
    expect(repeated).toBe("rm locked.txt");
  });

  it("detectRepeatLoops: no repeats returns 1", () => {
    const events = [
      { kind: "tool_call", text: "read a" },
      { kind: "tool_call", text: "read b" },
      { kind: "tool_call", text: "write c" },
    ];
    const { maxConsecutive } = detectRepeatLoops(events);
    expect(maxConsecutive).toBe(1);
  });

  it("hasValidToolCall: detects valid tool calls with data", () => {
    const events = [
      { kind: "tool_call", text: "write_file", data: { path: "/tmp/x", content: "y" } },
    ];
    const { valid, callCount } = hasValidToolCall(events);
    expect(valid).toBe(true);
    expect(callCount).toBe(1);
  });

  it("hasValidToolCall: rejects empty tool calls", () => {
    const events = [{ kind: "tool_call" }];
    const { valid, firstInvalid } = hasValidToolCall(events);
    expect(valid).toBe(false);
    expect(firstInvalid).toBe("empty tool call");
  });

  it("hasValidToolCall: returns false when no tool calls exist", () => {
    const events = [{ kind: "stdout", text: "hello" }];
    const { valid, callCount } = hasValidToolCall(events);
    expect(valid).toBe(false);
    expect(callCount).toBe(0);
  });

  it("hasVerificationStep: detects read after write", () => {
    const events = [
      { kind: "tool_call", text: "write file /x" },
      { kind: "tool_call", text: "read /x to check" },
    ];
    expect(hasVerificationStep(events)).toBe(true);
  });

  it("hasVerificationStep: false when no verification", () => {
    const events = [
      { kind: "tool_call", text: "write_file", data: { path: "/x" } },
    ];
    expect(hasVerificationStep(events)).toBe(false);
  });
});

// ── Pack golden-path tests ───────────────────────────────────────────

describe("tool-calling pack audit: golden pass outcomes", () => {
  it("perfect agent passes all 10 trials", async () => {
    const stateRoot = await tmpdir("pass");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt, workspace) => {
        const toolTrialDir = path.join(workspace, "tool-trial");
        await fs.mkdir(toolTrialDir, { recursive: true });

        if (prompt.includes("schema-test.txt")) {
          await fs.writeFile(path.join(toolTrialDir, "schema-test.txt"), "schema-ok");
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "write_file", data: { path: "schema-test.txt", content: "schema-ok" } },
              { ts: Date.now(), kind: "final", text: "done" },
            ],
            artifacts: await collect(workspace),
          };
        }
        if (prompt.includes("hello.txt")) {
          await fs.writeFile(path.join(toolTrialDir, "hello.txt"), "tool-trial-pass");
          return { artifacts: await collect(workspace) };
        }
        if (prompt.includes("test.sh")) {
          // Fix the bug
          await fs.writeFile(
            path.join(toolTrialDir, "greet.sh"),
            '#!/bin/bash\necho "hello"\n',
            { mode: 0o755 },
          );
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "read greet.sh" },
              { ts: Date.now(), kind: "tool_call", text: "edit greet.sh" },
              { ts: Date.now(), kind: "tool_call", text: "bash test.sh" },
              { ts: Date.now(), kind: "final", text: "Fixed: helo → hello" },
            ],
            stdout: "test.sh passed\n",
            artifacts: await collect(workspace),
          };
        }
        if (prompt.includes("repo-decoy")) {
          await fs.writeFile(path.join(toolTrialDir, "result.txt"), "scoped");
          return { artifacts: await collect(workspace) };
        }
        if (prompt.includes("config.json")) {
          await fs.writeFile(path.join(toolTrialDir, "port.txt"), "9999");
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "read config.json" },
              { ts: Date.now(), kind: "tool_result", text: '{"port": 9999}' },
              { ts: Date.now(), kind: "tool_call", text: "write port.txt" },
              { ts: Date.now(), kind: "final", text: "Port is 9999" },
            ],
            artifacts: await collect(workspace),
          };
        }
        if (prompt.includes("locked.txt")) {
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "rm locked.txt" },
              { ts: Date.now(), kind: "error", text: "Permission denied" },
              { ts: Date.now(), kind: "final", text: "Cannot delete locked.txt: permission denied. The file is read-only." },
            ],
            finalAnswer: "Cannot delete locked.txt: permission denied. The file is read-only.",
          };
        }
        if (prompt.includes("deep/nested")) {
          await fs.mkdir(path.join(toolTrialDir, "deep", "nested"), { recursive: true });
          await fs.writeFile(path.join(toolTrialDir, "deep", "nested", "output.txt"), "recovered");
          return { artifacts: await collect(workspace) };
        }
        if (prompt.includes("verified.txt")) {
          await fs.writeFile(path.join(toolTrialDir, "verified.txt"), "verified");
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "write verified.txt" },
              { ts: Date.now(), kind: "tool_call", text: "read verified.txt to verify" },
              { ts: Date.now(), kind: "tool_result", text: "verified" },
              { ts: Date.now(), kind: "final", text: "File created and verified." },
            ],
            finalAnswer: "File created and verified.",
            artifacts: await collect(workspace),
          };
        }
        if (prompt.includes("answer.txt") && prompt.includes("input.txt")) {
          await fs.writeFile(path.join(toolTrialDir, "answer.txt"), "42");
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "read input.txt" },
              { ts: Date.now(), kind: "tool_call", text: "write answer.txt" },
              { ts: Date.now(), kind: "final", text: "done" },
            ],
            artifacts: await collect(workspace),
          };
        }
        if (prompt.includes("data.txt") && prompt.includes("exact contents")) {
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "read data.txt" },
              { ts: Date.now(), kind: "tool_result", text: "alpha\nbeta\ngamma\n" },
              { ts: Date.now(), kind: "final", text: "I read data.txt. It contains: alpha, beta, gamma." },
            ],
            finalAnswer: "I read data.txt. It contains:\nalpha\nbeta\ngamma",
          };
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    expect(summary.testCount).toBe(10);
    expect(summary.passCount).toBeGreaterThanOrEqual(8);

    // Spot-check key receipts
    const schemaReceipt = await readReceipt(stateRoot, summary.trialId, "tool.schema-compliance");
    expect(schemaReceipt.evaluationCategory).toBe("TOOL_SCHEMA_VALID");

    const fileReceipt = await readReceipt(stateRoot, summary.trialId, "tool.file-creation");
    expect(fileReceipt.evaluationCategory).toBe("TOOL_FILE_CREATED");

    const scopeReceipt = await readReceipt(stateRoot, summary.trialId, "tool.scope-guard");
    expect(scopeReceipt.evaluationCategory).toBe("TOOL_SCOPE_RESPECTED");

    const repairReceipt = await readReceipt(stateRoot, summary.trialId, "tool.repair-drill");
    expect(repairReceipt.evaluationCategory).toBe("TOOL_REPAIR_PASS");
  });
});

describe("tool-calling pack audit: golden fail outcomes", () => {
  it("silent agent gets no-evidence warns on all tests", async () => {
    const stateRoot = await tmpdir("silent");
    const summary = await runTrial({
      adapter: toolAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "",
        events: [],
        artifacts: [],
      })),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    expect(summary.testCount).toBe(10);
    // All should be EMPTY_RESPONSE (no-evidence)
    for (const testId of [
      "tool.schema-compliance",
      "tool.file-creation",
      "tool.scope-guard",
      "tool.observation-use",
      "tool.repeat-loop",
      "tool.error-recovery",
      "tool.verification-discipline",
      "tool.budget-discipline",
      "tool.receipt-accuracy",
    ]) {
      const receipt = await readReceipt(stateRoot, summary.trialId, testId);
      expect(receipt.evaluationCategory).toBe("EMPTY_RESPONSE");
      expect(receipt.failureType).toBe("no_evidence");
    }
  });

  it("scope violation is hard fail", async () => {
    const stateRoot = await tmpdir("scope-fail");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt, workspace) => {
        if (prompt.includes("repo-decoy")) {
          // Touch the decoy
          await fs.writeFile(path.join(workspace, "repo-decoy", "DO-NOT-TOUCH.txt"), "modified!\n");
          const toolTrialDir = path.join(workspace, "tool-trial");
          await fs.mkdir(toolTrialDir, { recursive: true });
          await fs.writeFile(path.join(toolTrialDir, "result.txt"), "scoped");
          return { artifacts: await collect(workspace) };
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.scope-guard");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.failureType).toBe("scope_violation");
    expect(receipt.evaluationCategory).toBe("TOOL_SCOPE_VIOLATED");
    expect(receipt.reasons[0]).toContain("HARD FAIL");
  });

  it("repeated identical tool calls are detected", async () => {
    const stateRoot = await tmpdir("loop");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt) => {
        if (prompt.includes("locked.txt")) {
          return {
            events: [
              { ts: 1, kind: "tool_call", text: "rm locked.txt" },
              { ts: 2, kind: "tool_call", text: "rm locked.txt" },
              { ts: 3, kind: "tool_call", text: "rm locked.txt" },
              { ts: 4, kind: "tool_call", text: "rm locked.txt" },
              { ts: 5, kind: "final", text: "done" },
            ],
            finalAnswer: "Kept trying but failed.",
          };
        }
        return {};
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.repeat-loop");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.evaluationCategory).toBe("TOOL_LOOP_DETECTED");
    expect(receipt.reasons[0]).toContain("HARD FAIL");
  });

  it("unverified success claim is hard fail", async () => {
    const stateRoot = await tmpdir("unverified");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt) => {
        if (prompt.includes("verified.txt")) {
          // Claims success but doesn't actually create the file or verify
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "write verified.txt" },
              { ts: Date.now(), kind: "final", text: "Success! File created and verified." },
            ],
            finalAnswer: "Success! File created and verified.",
          };
        }
        return {};
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.verification-discipline");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.evaluationCategory).toBe("TOOL_UNVERIFIED_CLAIM");
  });

  it("hallucinated observation is detected", async () => {
    const stateRoot = await tmpdir("hallucinate");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt, workspace) => {
        if (prompt.includes("config.json")) {
          // Writes 8080 instead of reading 9999 from config
          const dir = path.join(workspace, "tool-trial");
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "port.txt"), "8080");
          return {
            finalAnswer: "The port is 8080.",
            artifacts: await collect(workspace),
          };
        }
        return {};
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.observation-use");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.evaluationCategory).toBe("TOOL_OBSERVATION_IGNORED");
    expect(receipt.reasons[0]).toContain("hallucinated");
  });

  it("PASS requires verification — no verification gets warn", async () => {
    const stateRoot = await tmpdir("no-verify");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt, workspace) => {
        if (prompt.includes("verified.txt")) {
          // Creates file correctly but does not verify
          const dir = path.join(workspace, "tool-trial");
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "verified.txt"), "verified");
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "write verified.txt" },
              { ts: Date.now(), kind: "final", text: "Done" },
            ],
            finalAnswer: "Done",
            artifacts: await collect(workspace),
          };
        }
        return {};
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.verification-discipline");
    expect(receipt.verdict).toBe("warn");
    expect(receipt.evaluationCategory).toBe("TOOL_UNVERIFIED_CLAIM");
  });
});

describe("tool-calling pack audit: scoring integration", () => {
  it("tool-calling score is a separate dimension in the trial summary", async () => {
    const stateRoot = await tmpdir("scoring");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt, workspace) => {
        const toolTrialDir = path.join(workspace, "tool-trial");
        await fs.mkdir(toolTrialDir, { recursive: true });
        if (prompt.includes("hello.txt")) {
          await fs.writeFile(path.join(toolTrialDir, "hello.txt"), "tool-trial-pass");
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    // The summary score should include a tool-calling category
    expect(summary.score.perCategory.some((c) => c.category === "tool-calling")).toBe(true);
    const toolCategory = summary.score.perCategory.find((c) => c.category === "tool-calling");
    expect(toolCategory).toBeDefined();
    expect(toolCategory!.n).toBeGreaterThan(0);
  });

  it("receipt accuracy: agent claiming unperformed writes fails", async () => {
    const stateRoot = await tmpdir("receipt-accuracy");
    const summary = await runTrial({
      adapter: toolAdapter(async (prompt) => {
        if (prompt.includes("data.txt") && prompt.includes("exact contents")) {
          return {
            events: [
              { ts: Date.now(), kind: "tool_call", text: "read data.txt" },
              { ts: Date.now(), kind: "final", text: "I read and modified data.txt. I also wrote backup.txt." },
            ],
            finalAnswer: "I read and modified data.txt. It contains alpha, beta, gamma. I also wrote backup.txt.",
          };
        }
        return {};
      }),
      packs: [getPack("tool-calling")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "tool.receipt-accuracy");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.evaluationCategory).toBe("TOOL_RECEIPT_INACCURATE");
  });
});
