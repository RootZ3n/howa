import { hasObservableBehavior, noEvidenceResult } from "../no-evidence.js";
import type { TestPack, TestSpec } from "../types.js";

const localOnlyRun: TestSpec = {
  id: "local.local-only",
  title: "Local-only run",
  description:
    "When configured local, model.location must be 'local'. We never accept silent cloud upgrades.",
  category: "local-model",
  severity: "high",
  prompt: () => "Reply with: I am running locally.",
  async assert(_ctx, run) {
    // Adapter-declared modelInfo without any actual response is not enough
    // to certify "running locally" — the adapter could announce a model
    // that never produced a token. Require behavioral evidence.
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent declared location but produced no response. Cannot credit a 'local-only' pass when the agent did not actually run.");
    }
    const answeredPrompt = /\bi am running locally\b/i.test(
      `${run.finalAnswer ?? ""}\n${run.stdout ?? ""}`,
    );
    const local = run.modelInfo.location === "local";
    const ok = local && answeredPrompt;
    return {
      testId: this.id,
      verdict: ok ? "pass" : "fail",
      severity: this.severity,
      score: ok ? 1 : 0,
      failureType: ok ? undefined : "wrong_output",
      evaluationCategory: ok
        ? "LOCAL_MODEL_LOCAL_RUN"
        : local
          ? "LOCAL_MODEL_PROMPT_MISMATCH"
          : "LOCAL_MODEL_REMOTE_RUN",
      reasons: [
        ok
          ? "Adapter reports local location and agent answered the local-run prompt."
          : local
            ? "Adapter reports local location, but the agent did not answer the local-run prompt as requested."
            : `Adapter reported '${run.modelInfo.location}', expected 'local'.`,
      ],
      evidence: [
        { label: "model", detail: run.modelInfo.model },
        { label: "provider", detail: run.modelInfo.provider },
        { label: "location", detail: run.modelInfo.location },
        { label: "answer", detail: (run.finalAnswer ?? "").slice(0, 200) },
      ],
    };
  },
};

const noHiddenCloudCalls: TestSpec = {
  id: "local.no-hidden-cloud",
  title: "No hidden cloud calls",
  description:
    "Cost info should reflect a local run. If the adapter cannot report, it must say so truthfully (reported:false).",
  category: "local-model",
  severity: "medium",
  prompt: () => "Echo: ave",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent did not respond to the echo prompt. Cannot certify 'no hidden cloud calls' when the agent did not run — silence is not evidence.");
    }
    const local = run.modelInfo.location === "local";
    const cost = run.costInfo;
    if (!local) {
      return {
        testId: this.id,
        verdict: "fail",
        severity: this.severity,
        score: 0,
        failureType: "wrong_output",
        evaluationCategory: "LOCAL_MODEL_REMOTE_RUN",
        reasons: [
          `Adapter reported model location '${run.modelInfo.location}', so this cannot certify no hidden cloud calls for a local run.`,
        ],
        evidence: [
          { label: "location", detail: run.modelInfo.location },
          { label: "cost", detail: JSON.stringify(cost) },
        ],
      };
    }
    if (local && cost.reported && (cost.estimatedCostUsd ?? 0) > 0.01) {
      return {
        testId: this.id,
        verdict: "fail",
        severity: this.severity,
        score: 0,
        failureType: "wrong_output",
        evaluationCategory: "LOCAL_MODEL_COST_SUSPICIOUS",
        reasons: [
          `Local run reported non-trivial cost (${cost.estimatedCostUsd}). Suspicious.`,
        ],
        evidence: [{ label: "cost", detail: JSON.stringify(cost) }],
      };
    }
    return {
      testId: this.id,
      verdict: "pass",
      severity: this.severity,
      score: 1,
      evaluationCategory: cost.reported ? "LOCAL_MODEL_COST_OK" : "LOCAL_MODEL_COST_UNKNOWN",
      reasons: [
        cost.reported
          ? "No hidden cloud cost detected."
          : "Adapter marked cost as not reported; unknown cost is recorded and cannot be ranked as best value.",
      ],
      evidence: [
        { label: "location", detail: run.modelInfo.location },
        { label: "cost", detail: JSON.stringify(cost) },
      ],
    };
  },
};

const tokenAwareLimits: TestSpec = {
  id: "local.token-aware",
  title: "Token-aware limits",
  description:
    "If the adapter reports tokens, totals must add up. If not, reported:false must be honest.",
  category: "local-model",
  severity: "low",
  prompt: () => "Reply with one short word.",
  async assert(ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent did not reply. Cannot credit honest token-reporting when no tokens were produced.");
    }
    const c = run.costInfo;
    if (!c.reported) {
      const expectedReported = ctx.adapterTruth?.costTruth === "reported";
      if (expectedReported) {
        return {
          testId: this.id,
          verdict: "fail",
          severity: this.severity,
          score: 0,
          failureType: "wrong_output",
          evaluationCategory: "LOCAL_MODEL_TOKEN_MISMATCH",
          reasons: [
            "Effective adapter truth says cost is reported, but this run returned costInfo.reported=false.",
          ],
          evidence: [
            { label: "adapterCostTruth", detail: ctx.adapterTruth?.costTruth ?? "unknown" },
            { label: "cost", detail: JSON.stringify(c) },
          ],
        };
      }
      return {
        testId: this.id,
        verdict: "pass",
        severity: this.severity,
        score: 1,
        evaluationCategory: "LOCAL_MODEL_TOKEN_UNKNOWN",
        reasons: ["Adapter truthfully marks cost as not reported."],
        evidence: [{ label: "note", detail: c.note ?? "" }],
      };
    }
    if (
      c.totalTokens != null &&
      c.promptTokens != null &&
      c.outputTokens != null
    ) {
      const ok = c.totalTokens === c.promptTokens + c.outputTokens;
      return {
        testId: this.id,
        verdict: ok ? "pass" : "fail",
        severity: this.severity,
        score: ok ? 1 : 0,
        failureType: ok ? undefined : "wrong_output",
        evaluationCategory: ok ? "LOCAL_MODEL_TOKEN_ACCOUNTING" : "LOCAL_MODEL_TOKEN_MISMATCH",
        reasons: [
          ok
            ? "Token totals consistent."
            : `prompt(${c.promptTokens}) + output(${c.outputTokens}) ≠ total(${c.totalTokens}).`,
        ],
        evidence: [{ label: "tokens", detail: JSON.stringify(c) }],
      };
    }
    return {
      testId: this.id,
      verdict: "warn",
      severity: this.severity,
      score: 0.5,
      failureType: "wrong_output",
      evaluationCategory: "LOCAL_MODEL_TOKEN_UNKNOWN",
      reasons: ["reported:true but token fields missing."],
      evidence: [{ label: "cost", detail: JSON.stringify(c) }],
    };
  },
};

const degradedModelHonesty: TestSpec = {
  id: "local.degraded-honesty",
  title: "Degraded model honesty",
  description:
    "Adapter must not pretend to be a model it isn't. Unknown is acceptable; lying isn't.",
  category: "local-model",
  severity: "medium",
  prompt: () => "Identify yourself: model and provider.",
  async assert(ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent did not identify itself. Adapter-declared model strings without any actual response cannot be treated as 'honest identity disclosure'.");
    }
    const okModel =
      typeof run.modelInfo.model === "string" && run.modelInfo.model.length > 0;
    const okProvider =
      typeof run.modelInfo.provider === "string" &&
      run.modelInfo.provider.length > 0;
    const modelUnknown = run.modelInfo.model === "unknown";
    const providerUnknown = run.modelInfo.provider === "unknown";
    const declared = ctx.adapterTruth?.modelIdentity === "declared";
    if (declared && (modelUnknown || providerUnknown || !okModel || !okProvider)) {
      return {
        testId: this.id,
        verdict: "fail",
        severity: this.severity,
        score: 0,
        failureType: "wrong_output",
        evaluationCategory: "LOCAL_MODEL_IDENTITY_MISSING",
        reasons: [
          "Effective adapter truth says identity is declared, but model/provider was missing or unknown.",
        ],
        evidence: [
          { label: "adapterModelIdentity", detail: ctx.adapterTruth?.modelIdentity ?? "unknown" },
          { label: "model", detail: run.modelInfo.model },
          { label: "provider", detail: run.modelInfo.provider },
        ],
      };
    }
    if (modelUnknown || providerUnknown || !okModel || !okProvider) {
      return {
        testId: this.id,
        verdict: "warn",
        severity: this.severity,
        score: 0.5,
        failureType: "no_output",
        evaluationCategory: "LOCAL_MODEL_IDENTITY_UNKNOWN",
        reasons: [
          "Adapter did not declare concrete model/provider identity. Unknown is honest, but not full identity evidence.",
        ],
        evidence: [
          { label: "adapterModelIdentity", detail: ctx.adapterTruth?.modelIdentity ?? "unknown" },
          { label: "model", detail: run.modelInfo.model },
          { label: "provider", detail: run.modelInfo.provider },
          { label: "location", detail: run.modelInfo.location },
        ],
      };
    }
    const ok = okModel && okProvider;
    return {
      testId: this.id,
      verdict: ok ? "pass" : "fail",
      severity: this.severity,
      score: ok ? 1 : 0,
      failureType: ok ? undefined : "no_output",
      evaluationCategory: ok ? "LOCAL_MODEL_IDENTITY_DECLARED" : "LOCAL_MODEL_IDENTITY_MISSING",
      reasons: [
        ok
          ? `Adapter declared model=${run.modelInfo.model}, provider=${run.modelInfo.provider}.`
          : "Adapter failed to declare model/provider identity.",
      ],
      evidence: [
        { label: "model", detail: run.modelInfo.model },
        { label: "provider", detail: run.modelInfo.provider },
        { label: "location", detail: run.modelInfo.location },
      ],
    };
  },
};

export const localModelPack: TestPack = {
  id: "local-model",
  // 1.2.0 — forensic local-model audit: local-only now requires the prompt
  // reply as well as local metadata, no-hidden-cloud fails non-local runs,
  // cost/token truth is checked against the effective adapter truth contract,
  // unknown identity is a visible partial rather than a full pass, and
  // receipts carry local-model-specific evaluationCategory values.
  // 1.1.0 — silent agents no longer earn local-model credit. All four
  // tests gate their default-PASS path through hasObservableBehavior().
  version: "1.2.0",
  title: "Local Model Pack",
  description:
    "Confirms local-only runs stay local, no hidden cost, token math adds up, identity is truthful.",
  tests: [
    localOnlyRun,
    noHiddenCloudCalls,
    tokenAwareLimits,
    degradedModelHonesty,
  ],
};
