import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runTrial } from "@colosseum/runner/trial-runner.js";
import { getPack } from "@colosseum/packs/registry.js";
import { renderReceipt } from "@colosseum/receipts/receipt.js";
import { buildAgentFixReport } from "@colosseum/ui/report.js";
import type { AgentAdapter } from "@colosseum/adapters/types.js";
import type { AgentArtifact, AgentRunResult, ModelInfo } from "@colosseum/types.js";
import type { TestContext } from "@colosseum/packs/types.js";

async function tmpdir(prefix: string): Promise<string> {
  const d = path.join(
    os.tmpdir(),
    `colosseum-repo-audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(d, { recursive: true });
  return d;
}

const modelInfo: ModelInfo = {
  model: "repo-audit-model",
  provider: "repo-audit",
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

function repoAdapter(
  handler: (prompt: string, workspace: string) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>,
): AgentAdapter {
  let workspace = "";
  return {
    id: "repo-audit",
    version: "0.0.1",
    name: "Repo Audit Adapter",
    description: "Deterministic adapter for repo-editing pack audit tests.",
    capabilities: {
      streaming: false,
      toolUse: true,
      fileEditing: true,
      shellExecution: false,
      modelSelection: false,
      reportsCost: true,
      reportsTokens: true,
    },
    truth: {
      modelIdentity: "declared",
      costTruth: "reported",
      eventStructure: "unstructured",
      toolSupport: true,
    },
    async health() {
      return { ok: true };
    },
    async startSession(opts) {
      workspace = opts.workspace;
      return { sessionId: `repo-${Math.random()}`, workspace, modelInfo };
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
    repoDiffStatus?: string;
    repoDiffSummary?: string;
  };
}

describe("repo-editing pack audit: golden outcomes", () => {
  it("pass golden: exact edit, scoped README edit, clean no-op, and contained artifact pass", async () => {
    const stateRoot = await tmpdir("pass");
    const summary = await runTrial({
      adapter: repoAdapter(async (prompt, workspace) => {
        if (prompt.includes("src/greet.ts")) {
          await fs.writeFile(
            path.join(workspace, "src", "greet.ts"),
            "export const greet = () => 'salve';\n",
          );
        } else if (prompt.includes("README.md")) {
          await fs.writeFile(path.join(workspace, "README.md"), "# arena-repo\n");
        } else if (prompt.includes("out/note.txt")) {
          await fs.mkdir(path.join(workspace, "out"), { recursive: true });
          await fs.writeFile(path.join(workspace, "out", "note.txt"), "contained\n");
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("repo-editing")],
      stateRoot,
    });

    expect(summary.verdict).toBe("pass");
    expect(summary.passCount).toBe(4);
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.correct-edit"))
        .evaluationCategory,
    ).toBe("REPO_CORRECT_EDIT");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.no-unexpected-files"))
        .evaluationCategory,
    ).toBe("REPO_SCOPE_DISCIPLINE");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.artifacts-contained"))
        .evaluationCategory,
    ).toBe("REPO_CONTAINED_ARTIFACT");
  });

  it("fail golden: wrong content, missing requested edit, stray files, and missing artifact are classified", async () => {
    const stateRoot = await tmpdir("fail");
    const summary = await runTrial({
      adapter: repoAdapter(async (prompt, workspace) => {
        if (prompt.includes("src/greet.ts")) {
          await fs.writeFile(path.join(workspace, "src", "greet.ts"), "const x = 'salve';\n");
        } else if (prompt.includes("README.md")) {
          // Leave README untouched; sentinel is untouched too.
        } else if (prompt.includes("Do not create files")) {
          await fs.writeFile(path.join(workspace, "stray.log"), "noise\n");
        } else if (prompt.includes("out/note.txt")) {
          // Observable behavior, but no requested artifact.
          return { finalAnswer: "I thought about it.", stdout: "I thought about it.\n" };
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("repo-editing")],
      stateRoot,
    });

    expect(summary.verdict).toBe("fail");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.correct-edit"))
        .evaluationCategory,
    ).toBe("REPO_CONTENT_MISMATCH");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.no-unexpected-files"))
        .evaluationCategory,
    ).toBe("REPO_CONTENT_MISMATCH");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.clean-on-failure"))
        .evaluationCategory,
    ).toBe("REPO_STRAY_ARTIFACTS");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.artifacts-contained"))
        .evaluationCategory,
    ).toBe("REPO_MISSING_ARTIFACT");
  });

  it("artifact escape golden: adapter-reported escaped artifact is REPO_ARTIFACT_ESCAPE", async () => {
    const stateRoot = await tmpdir("escape");
    const summary = await runTrial({
      adapter: repoAdapter(async (prompt, workspace) => {
        if (prompt.includes("out/note.txt")) {
          await fs.mkdir(path.join(workspace, "out"), { recursive: true });
          await fs.writeFile(path.join(workspace, "out", "note.txt"), "contained\n");
          return {
            artifacts: [
              ...(await collect(workspace)),
              { path: "../escaped.txt", bytes: 7, preview: "escaped" },
            ],
          };
        }
        return { artifacts: await collect(workspace) };
      }),
      packs: [getPack("repo-editing")],
      stateRoot,
    });
    const receipt = await readReceipt(
      stateRoot,
      summary.trialId,
      "repo.artifacts-contained",
    );
    expect(receipt.verdict).toBe("fail");
    expect(receipt.failureType).toBe("scope_violation");
    expect(receipt.evaluationCategory).toBe("REPO_ARTIFACT_ESCAPE");
  });
});

describe("repo-editing pack audit: empty, provider, timeout, fixtures, and bindings", () => {
  it("empty response is EMPTY_RESPONSE for behavior-required repo tests, while no-op cleanup can pass", async () => {
    const stateRoot = await tmpdir("empty");
    const summary = await runTrial({
      adapter: repoAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "",
        events: [],
        artifacts: [],
      })),
      packs: [getPack("repo-editing")],
      stateRoot,
    });

    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.correct-edit"))
        .evaluationCategory,
    ).toBe("EMPTY_RESPONSE");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.no-unexpected-files"))
        .evaluationCategory,
    ).toBe("EMPTY_RESPONSE");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.artifacts-contained"))
        .evaluationCategory,
    ).toBe("EMPTY_RESPONSE");
    expect(
      (await readReceipt(stateRoot, summary.trialId, "repo.clean-on-failure"))
        .evaluationCategory,
    ).toBe("REPO_CLEAN_NOOP");
  });

  it("provider failure is INFRA_FAILURE, not repo behavior failure", async () => {
    const stateRoot = await tmpdir("provider");
    const summary = await runTrial({
      adapter: repoAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "Error: No API key found for provider openai.",
        exitCode: 1,
        events: [],
        artifacts: [],
      })),
      packs: [getPack("repo-editing")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "repo.correct-edit");
    expect(receipt.failureType).toBe("infrastructure_failure");
    expect(receipt.evaluationCategory).toBe("INFRA_FAILURE");
  });

  it("timeout is TIMEOUT, not wrong output", async () => {
    const stateRoot = await tmpdir("timeout");
    const summary = await runTrial({
      adapter: repoAdapter(() => ({
        finalAnswer: undefined,
        stdout: "",
        stderr: "timeout: deadline exceeded",
        exitCode: 124,
        events: [],
        artifacts: [],
      })),
      packs: [getPack("repo-editing")],
      stateRoot,
    });
    const receipt = await readReceipt(stateRoot, summary.trialId, "repo.correct-edit");
    expect(receipt.failureType).toBe("timeout");
    expect(receipt.evaluationCategory).toBe("TIMEOUT");
  });

  it("fixture integrity: seeded sentinel and README are not leaked in prompt and are verified independently", async () => {
    const pack = getPack("repo-editing");
    const test = pack.tests.find((t) => t.id === "repo.no-unexpected-files");
    expect(test).toBeDefined();
    const workspace = await tmpdir("fixture");
    const ctx: TestContext = { workspace, fixtureRoot: workspace };
    await test!.setup?.(ctx);
    const prompt = await test!.prompt(ctx);
    expect(prompt).not.toContain("untouched");
    expect(await fs.readFile(path.join(workspace, "do-not-touch", "sentinel.txt"), "utf8")).toBe("untouched\n");
    expect(await fs.readFile(path.join(workspace, "README.md"), "utf8")).toBe("# repo\n");
  });

  it("receipt markdown, JSON, and export text carry repo evaluationCategory and diff status", async () => {
    const stateRoot = await tmpdir("binding");
    const summary = await runTrial({
      adapter: repoAdapter(() => ({ finalAnswer: "done", stdout: "done\n" })),
      packs: [getPack("repo-editing")],
      stateRoot,
    });
    const fullReceipt = JSON.parse(
      await fs.readFile(
        path.join(stateRoot, "receipts", summary.trialId, "repo.no-unexpected-files.json"),
        "utf8",
      ),
    );
    expect(fullReceipt.evaluationCategory).toBe("REPO_CONTENT_MISMATCH");
    expect(fullReceipt.repoDiffStatus).toBeDefined();
    expect(renderReceipt(fullReceipt)).toContain(
      "**Evaluation category:** REPO_CONTENT_MISMATCH",
    );
    expect(buildAgentFixReport(summary, [fullReceipt])).toContain(
      "Evaluation category: REPO_CONTENT_MISMATCH",
    );
  });
});
