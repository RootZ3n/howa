import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@howa/runner/trial-runner.js";
import { getPack } from "@howa/packs/registry.js";
import { renderReceipt } from "@howa/receipts/receipt.js";
import { buildAgentFixReport } from "@howa/ui/report.js";
import type { AgentAdapter, AdapterTruthContract } from "@howa/adapters/types.js";
import type { AgentRunResult, CostInfo, ModelInfo } from "@howa/types.js";

async function tmpdir(prefix: string): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `howa-local-audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

const localInfo: ModelInfo = {
  model: "llama3-local",
  provider: "ollama",
  location: "local",
};

const reportedCost: CostInfo = {
  reported: true,
  promptTokens: 4,
  outputTokens: 3,
  totalTokens: 7,
  estimatedCostUsd: 0,
};

function baseRun(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    events: [{ ts: Date.now(), kind: "final", text: "I am running locally." }],
    artifacts: [],
    exitCode: 0,
    modelInfo: localInfo,
    costInfo: reportedCost,
    durationMs: 1,
    stdout: "I am running locally.\n",
    stderr: "",
    finalAnswer: "I am running locally.",
    ...overrides,
  };
}

function localAdapter(
  handler: (prompt: string) => Partial<AgentRunResult>,
  truth: AdapterTruthContract = {
    modelIdentity: "declared",
    costTruth: "reported",
    eventStructure: "unstructured",
    toolSupport: false,
  },
): AgentAdapter {
  return {
    id: "local-audit",
    version: "0.0.1",
    name: "Local Audit Adapter",
    description: "Deterministic adapter for local-model pack audit tests.",
    capabilities: {
      streaming: false,
      toolUse: false,
      fileEditing: false,
      shellExecution: false,
      modelSelection: true,
      reportsCost: truth.costTruth !== "unknown",
      reportsTokens: truth.costTruth !== "unknown",
    },
    truth,
    async health() {
      return { ok: true };
    },
    async startSession(opts) {
      return {
        sessionId: `local-${Math.random()}`,
        workspace: opts.workspace,
        modelInfo: localInfo,
      };
    },
    async sendPrompt(_handle, prompt) {
      return baseRun(handler(prompt));
    },
    async stop() {},
    async collectArtifacts() {
      return [];
    },
    async getModelInfo() {
      return localInfo;
    },
    async getCostInfo() {
      return reportedCost;
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
    modelInfo: ModelInfo;
    costInfo: CostInfo;
  };
}

describe("local-model pack audit: golden outcomes", () => {
  it("pass golden: local metadata, local prompt answer, zero cost, token math, and declared identity pass", async () => {
    const stateRoot = await tmpdir("pass");
    const summary = await runTrial({
      adapter: localAdapter(() => ({})),
      packs: [getPack("local-model")],
      stateRoot,
    });

    expect(summary.verdict).toBe("pass");
    expect(summary.passCount).toBe(4);
    expect((await readReceipt(stateRoot, summary.trialId, "local.local-only")).evaluationCategory).toBe("LOCAL_MODEL_LOCAL_RUN");
    expect((await readReceipt(stateRoot, summary.trialId, "local.no-hidden-cloud")).evaluationCategory).toBe("LOCAL_MODEL_COST_OK");
    expect((await readReceipt(stateRoot, summary.trialId, "local.token-aware")).evaluationCategory).toBe("LOCAL_MODEL_TOKEN_ACCOUNTING");
    expect((await readReceipt(stateRoot, summary.trialId, "local.degraded-honesty")).evaluationCategory).toBe("LOCAL_MODEL_IDENTITY_DECLARED");
  });

  it("fail golden: cloud location, suspicious local cost, bad token totals, and missing declared identity are classified", async () => {
    const stateRoot = await tmpdir("fail");
    const summary = await runTrial({
      adapter: localAdapter((prompt) => {
        if (prompt.includes("I am running locally")) {
          return {
            modelInfo: { model: "gpt-cloud", provider: "openai", location: "cloud" },
            finalAnswer: "I am running locally.",
            stdout: "I am running locally.\n",
          };
        }
        if (prompt.includes("Echo: ave")) {
          return {
            modelInfo: localInfo,
            costInfo: { reported: true, estimatedCostUsd: 0.25 },
          };
        }
        if (prompt.includes("one short word")) {
          return {
            costInfo: {
              reported: true,
              promptTokens: 5,
              outputTokens: 5,
              totalTokens: 99,
              estimatedCostUsd: 0,
            },
          };
        }
        return {
          modelInfo: { model: "unknown", provider: "unknown", location: "local" },
        };
      }),
      packs: [getPack("local-model")],
      stateRoot,
    });

    expect(summary.verdict).toBe("fail");
    expect((await readReceipt(stateRoot, summary.trialId, "local.local-only")).evaluationCategory).toBe("LOCAL_MODEL_REMOTE_RUN");
    expect((await readReceipt(stateRoot, summary.trialId, "local.no-hidden-cloud")).evaluationCategory).toBe("LOCAL_MODEL_COST_SUSPICIOUS");
    expect((await readReceipt(stateRoot, summary.trialId, "local.token-aware")).evaluationCategory).toBe("LOCAL_MODEL_TOKEN_MISMATCH");
    expect((await readReceipt(stateRoot, summary.trialId, "local.degraded-honesty")).evaluationCategory).toBe("LOCAL_MODEL_IDENTITY_MISSING");
  });

  it("partial/unknown golden: honest unknown cost and identity are visible, not full declared evidence", async () => {
    const stateRoot = await tmpdir("unknown");
    const unknownTruth: AdapterTruthContract = {
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: false,
    };
    const summary = await runTrial({
      adapter: localAdapter(
        (prompt) => {
          if (prompt.includes("model and provider")) {
            return {
              modelInfo: { model: "unknown", provider: "unknown", location: "local" },
              costInfo: { reported: false, note: "adapter cannot report cost" },
            };
          }
          return {
            costInfo: { reported: false, note: "adapter cannot report cost" },
          };
        },
        unknownTruth,
      ),
      packs: [getPack("local-model")],
      stateRoot,
    });

    expect(summary.verdict).toBe("warn");
    expect((await readReceipt(stateRoot, summary.trialId, "local.no-hidden-cloud")).evaluationCategory).toBe("LOCAL_MODEL_COST_UNKNOWN");
    expect((await readReceipt(stateRoot, summary.trialId, "local.token-aware")).evaluationCategory).toBe("LOCAL_MODEL_TOKEN_UNKNOWN");
    const identity = await readReceipt(stateRoot, summary.trialId, "local.degraded-honesty");
    expect(identity.verdict).toBe("warn");
    expect(identity.evaluationCategory).toBe("LOCAL_MODEL_IDENTITY_UNKNOWN");
  });

  it("prompt mismatch: local metadata alone does not pass local-only", async () => {
    const stateRoot = await tmpdir("prompt");
    const summary = await runTrial({
      adapter: localAdapter((prompt) =>
        prompt.includes("I am running locally")
          ? { finalAnswer: "hello", stdout: "hello\n" }
          : {},
      ),
      packs: [getPack("local-model")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "local.local-only");
    expect(receipt.verdict).toBe("fail");
    expect(receipt.evaluationCategory).toBe("LOCAL_MODEL_PROMPT_MISMATCH");
  });
});

describe("local-model pack audit: empty, provider, timeout, fixture integrity, and bindings", () => {
  it("empty response is EMPTY_RESPONSE, not metadata-only success", async () => {
    const stateRoot = await tmpdir("empty");
    const summary = await runTrial({
      adapter: localAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "",
        events: [],
        artifacts: [],
      })),
      packs: [getPack("local-model")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "local.local-only");
    expect(receipt.verdict).toBe("warn");
    expect(receipt.failureType).toBe("no_evidence");
    expect(receipt.evaluationCategory).toBe("EMPTY_RESPONSE");
  });

  it("provider failure is INFRA_FAILURE, not local-model behavior failure", async () => {
    const stateRoot = await tmpdir("provider");
    const summary = await runTrial({
      adapter: localAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "Error: No API key found for provider openai.",
        exitCode: 1,
        events: [],
      })),
      packs: [getPack("local-model")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "local.local-only");
    expect(receipt.failureType).toBe("infrastructure_failure");
    expect(receipt.evaluationCategory).toBe("INFRA_FAILURE");
  });

  it("timeout is TIMEOUT, not local-model behavior failure", async () => {
    const stateRoot = await tmpdir("timeout");
    const summary = await runTrial({
      adapter: localAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "timeout: deadline exceeded",
        exitCode: 124,
        events: [],
      })),
      packs: [getPack("local-model")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "local.local-only");
    expect(receipt.failureType).toBe("timeout");
    expect(receipt.evaluationCategory).toBe("TIMEOUT");
  });

  it("fixture/prompt integrity: prompts do not leak model/provider answers or cost numbers", async () => {
    const pack = getPack("local-model");
    for (const test of pack.tests) {
      const prompt = await test.prompt({
        workspace: "/tmp/howa-local-audit",
        fixtureRoot: "/tmp/howa-local-audit",
      } as never);
      expect(prompt).not.toMatch(/llama3-local|ollama|estimatedCostUsd|promptTokens|outputTokens/);
    }
  });

  it("receipt markdown, JSON, and export text carry local-model evaluationCategory", async () => {
    const stateRoot = await tmpdir("binding");
    const summary = await runTrial({
      adapter: localAdapter(() => ({
        modelInfo: { model: "gpt-cloud", provider: "openai", location: "cloud" },
        finalAnswer: "I am running locally.",
        stdout: "I am running locally.\n",
      })),
      packs: [getPack("local-model")],
      stateRoot,
    });
    const fullReceipt = JSON.parse(
      await fs.readFile(
        path.join(stateRoot, "receipts", summary.trialId, "local.local-only.json"),
        "utf8",
      ),
    );
    expect(fullReceipt.evaluationCategory).toBe("LOCAL_MODEL_REMOTE_RUN");
    expect(renderReceipt(fullReceipt)).toContain(
      "**Evaluation category:** LOCAL_MODEL_REMOTE_RUN",
    );
    expect(buildAgentFixReport(summary, [fullReceipt])).toContain(
      "Evaluation category: LOCAL_MODEL_REMOTE_RUN",
    );
  });
});
