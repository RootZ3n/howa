import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@colosseum/runner/trial-runner.js";
import { getPack } from "@colosseum/packs/registry.js";
import { renderReceipt } from "@colosseum/receipts/receipt.js";
import { buildAgentFixReport } from "@colosseum/ui/report.js";
import type { AgentAdapter, AdapterTruthContract } from "@colosseum/adapters/types.js";
import type { AgentRunResult, ModelInfo } from "@colosseum/types.js";

async function tmpdir(prefix: string): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `colosseum-stamina-audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

const modelInfo: ModelInfo = {
  model: "stamina-audit-model",
  provider: "stamina-audit",
  location: "local",
};

const structuredTruth: AdapterTruthContract = {
  modelIdentity: "declared",
  costTruth: "reported",
  eventStructure: "structured",
  toolSupport: true,
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

function staminaAdapter(
  handler: (prompt: string) => Partial<AgentRunResult>,
  truth: AdapterTruthContract = structuredTruth,
): AgentAdapter {
  return {
    id: "stamina-audit",
    version: "0.0.1",
    name: "Stamina Audit Adapter",
    description: "Deterministic adapter for stamina pack audit tests.",
    capabilities: {
      streaming: false,
      toolUse: truth.toolSupport,
      fileEditing: false,
      shellExecution: false,
      modelSelection: false,
      reportsCost: truth.costTruth !== "unknown",
      reportsTokens: truth.costTruth !== "unknown",
    },
    truth,
    async health() {
      return { ok: true };
    },
    async startSession(opts) {
      return { sessionId: `stamina-${Math.random()}`, workspace: opts.workspace, modelInfo };
    },
    async sendPrompt(_handle, prompt) {
      return baseRun(handler(prompt));
    },
    async stop() {},
    async collectArtifacts() {
      return [];
    },
    async getModelInfo() {
      return modelInfo;
    },
    async getCostInfo() {
      return { reported: true, estimatedCostUsd: 0, totalTokens: 0 };
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

describe("stamina pack audit: golden outcomes", () => {
  it("pass golden: step evidence, bounded retry, clean stop, and long prompt all pass", async () => {
    const stateRoot = await tmpdir("pass");
    const summary = await runTrial({
      adapter: staminaAdapter((prompt) => {
        if (prompt.includes("Plan four sub-steps")) {
          const ts = Date.now();
          return {
            events: [
              { ts, kind: "thought", text: "Step 1/4 plan" },
              { ts: ts + 1, kind: "thought", text: "Step 2/4 sketch" },
              { ts: ts + 2, kind: "tool_call", text: "Step 3/4 verify" },
              { ts: ts + 3, kind: "thought", text: "Step 4/4 summarize" },
            ],
            finalAnswer: "Plan: four steps. Done.",
            stdout: "Plan: four steps. Done.\n",
            durationMs: 4,
          };
        }
        if (prompt === "Reply 'ok'.") {
          return { finalAnswer: "ok", stdout: "ok\n", durationMs: 1 };
        }
        if (prompt.startsWith("long-task: ")) {
          return { finalAnswer: "handled long prompt", stdout: "handled long prompt\n", durationMs: 10 };
        }
        return { finalAnswer: "retried twice, then explained", stdout: "retried twice, then explained\n", durationMs: 20 };
      }),
      packs: [getPack("stamina")],
      stateRoot,
    });

    expect(summary.verdict).toBe("pass");
    expect(summary.passCount).toBe(4);
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.multi-step")).evaluationCategory).toBe("STAMINA_MULTISTEP_OBSERVED");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.bounded-retries")).evaluationCategory).toBe("STAMINA_BOUNDED_RETRY");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.stop-behavior")).evaluationCategory).toBe("STAMINA_STOP_CLEAN");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.long-prompt")).evaluationCategory).toBe("STAMINA_LONG_PROMPT_HANDLED");
  });

  it("fail golden: missing steps, unbounded retry, bad stop, and long-prompt no-final are classified", async () => {
    const stateRoot = await tmpdir("fail");
    const summary = await runTrial({
      adapter: staminaAdapter((prompt) => {
        if (prompt.includes("Plan four sub-steps")) {
          return { finalAnswer: "done in one shot", stdout: "done in one shot\n" };
        }
        if (prompt.includes("Retry at most twice")) {
          return { finalAnswer: "still retrying", stdout: "still retrying\n", durationMs: 40_001 };
        }
        if (prompt === "Reply 'ok'.") {
          return { finalAnswer: "could not stop", stdout: "could not stop\n", exitCode: 2 };
        }
        return { finalAnswer: undefined, stdout: "processed bytes\n", exitCode: 0 };
      }),
      packs: [getPack("stamina")],
      stateRoot,
    });

    expect(summary.verdict).toBe("warn");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.multi-step")).evaluationCategory).toBe("STAMINA_MULTISTEP_MISSING");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.bounded-retries")).evaluationCategory).toBe("STAMINA_RETRY_UNBOUNDED");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.stop-behavior")).evaluationCategory).toBe("STAMINA_STOP_FAILED");
    expect((await readReceipt(stateRoot, summary.trialId, "stamina.long-prompt")).evaluationCategory).toBe("STAMINA_LONG_PROMPT_FAILED");
  });

  it("partial golden: unstructured adapter with final answer is limited observability, not full pass", async () => {
    const stateRoot = await tmpdir("partial");
    const summary = await runTrial({
      adapter: staminaAdapter(
        () => ({ finalAnswer: "I completed the task.", stdout: "I completed the task.\n" }),
        {
          modelIdentity: "unknown",
          costTruth: "unknown",
          eventStructure: "unstructured",
          toolSupport: true,
        },
      ),
      packs: [getPack("stamina")],
      stateRoot,
    });

    const receipt = await readReceipt(stateRoot, summary.trialId, "stamina.multi-step");
    expect(receipt.verdict).toBe("warn");
    expect(receipt.failureType).toBe("incomplete_execution");
    expect(receipt.evaluationCategory).toBe("STAMINA_MULTISTEP_LIMITED_OBSERVABILITY");
  });
});

describe("stamina pack audit: empty, provider, timeout, fixture integrity, and bindings", () => {
  it("empty response is EMPTY_RESPONSE, not stamina success", async () => {
    const stateRoot = await tmpdir("empty");
    const summary = await runTrial({
      adapter: staminaAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "",
        events: [],
        artifacts: [],
      })),
      packs: [getPack("stamina")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "stamina.bounded-retries");
    expect(receipt.verdict).toBe("warn");
    expect(receipt.failureType).toBe("no_evidence");
    expect(receipt.evaluationCategory).toBe("EMPTY_RESPONSE");
  });

  it("provider failure is INFRA_FAILURE, not retry behavior failure", async () => {
    const stateRoot = await tmpdir("provider");
    const summary = await runTrial({
      adapter: staminaAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "Error: No API key found for provider openai.",
        exitCode: 1,
        events: [],
      })),
      packs: [getPack("stamina")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "stamina.bounded-retries");
    expect(receipt.failureType).toBe("infrastructure_failure");
    expect(receipt.evaluationCategory).toBe("INFRA_FAILURE");
  });

  it("timeout is TIMEOUT, not retry behavior failure", async () => {
    const stateRoot = await tmpdir("timeout");
    const summary = await runTrial({
      adapter: staminaAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "timeout: deadline exceeded",
        exitCode: 124,
        events: [],
      })),
      packs: [getPack("stamina")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "stamina.bounded-retries");
    expect(receipt.failureType).toBe("timeout");
    expect(receipt.evaluationCategory).toBe("TIMEOUT");
  });

  it("fixture/prompt integrity: prompts do not leak step counts, durations, or verdict categories", async () => {
    const pack = getPack("stamina");
    for (const test of pack.tests) {
      const prompt = await test.prompt({
        workspace: "/tmp/colosseum-stamina-audit",
        fixtureRoot: "/tmp/colosseum-stamina-audit",
      } as never);
      expect(prompt).not.toMatch(/STAMINA_|evaluationCategory|30_000|900_000|600_000|stepCount/);
    }
  });

  it("receipt markdown, JSON, and export text carry stamina evaluationCategory", async () => {
    const stateRoot = await tmpdir("binding");
    const summary = await runTrial({
      adapter: staminaAdapter((prompt) =>
        prompt.includes("Plan four sub-steps")
          ? { finalAnswer: "done in one shot", stdout: "done in one shot\n" }
          : {},
      ),
      packs: [getPack("stamina")],
      stateRoot,
    });
    const fullReceipt = JSON.parse(
      await fs.readFile(
        path.join(stateRoot, "receipts", summary.trialId, "stamina.multi-step.json"),
        "utf8",
      ),
    );
    expect(fullReceipt.evaluationCategory).toBe("STAMINA_MULTISTEP_MISSING");
    expect(renderReceipt(fullReceipt)).toContain(
      "**Evaluation category:** STAMINA_MULTISTEP_MISSING",
    );
    expect(buildAgentFixReport(summary, [fullReceipt])).toContain(
      "Evaluation category: STAMINA_MULTISTEP_MISSING",
    );
  });

  it("unstructured adapter gets score 0.6, structured adapter gets 0.5 for missing steps", async () => {
    // Test directly via the pack assertion to verify score values.
    const pack = getPack("stamina");
    const multiStepTest = pack.tests.find((t) => t.id === "stamina.multi-step")!;

    // Unstructured adapter — cannot surface events, so it gets a more lenient score.
    const unstructuredResult = await multiStepTest.assert(
      { workspace: "/tmp/x", fixtureRoot: "/tmp/x", adapterTruth: {
        modelIdentity: "declared",
        costTruth: "reported",
        eventStructure: "unstructured",
        toolSupport: true,
      }},
      baseRun({ finalAnswer: "I completed the task.", stdout: "I completed the task.\n" }),
    );
    expect(unstructuredResult.evaluationCategory).toBe("STAMINA_MULTISTEP_LIMITED_OBSERVABILITY");
    expect(unstructuredResult.score).toBe(0.6);

    // Structured adapter — could have surfaced events but didn't.
    const structuredResult = await multiStepTest.assert(
      { workspace: "/tmp/x", fixtureRoot: "/tmp/x", adapterTruth: structuredTruth },
      baseRun({ finalAnswer: "I completed the task.", stdout: "I completed the task.\n" }),
    );
    expect(structuredResult.evaluationCategory).toBe("STAMINA_MULTISTEP_MISSING");
    expect(structuredResult.score).toBe(0.5);
  });
});
