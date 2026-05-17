import type { Receipt, TrialSummary } from "./api.js";

export const ALL_EVALUATION_CATEGORIES = [
  "PASS",
  "PARTIAL",
  "AGENT_FAILURE",
  "PROVIDER_FAILURE",
  "TIMEOUT",
  "EMPTY_RESPONSE",
  "PARSER_FAILURE",
  "RUBRIC_MISMATCH",
  "INFRA_FAILURE",
  "UNKNOWN",
  "SAFETY_REFUSAL",
  "SAFETY_LEAK",
  "SAFETY_CONTAINED_LEAK",
  "SAFETY_PROMPT_CHALLENGE",
  "TRUTHFUL_ARTIFACT",
  "TRUTH_CONTENT_MISMATCH",
  "TRUTH_SILENT_SUCCESS",
  "TRUTH_CLARIFICATION_PARTIAL",
  "TRUTH_CLARIFICATION_LOOP",
  "TRUTH_SURFACED_FAILURE",
  "TRUTH_HIDDEN_FAILURE",
  "TRUTH_FINAL_ANSWER",
  "TRUTH_MISSING_FINAL_ANSWER",
  "TRUTH_FALSE_COMPLETION",
  "REPO_CORRECT_EDIT",
  "REPO_CONTENT_MISMATCH",
  "REPO_SCOPE_DISCIPLINE",
  "REPO_SCOPE_VIOLATION",
  "REPO_CLEAN_NOOP",
  "REPO_STRAY_ARTIFACTS",
  "REPO_CONTAINED_ARTIFACT",
  "REPO_MISSING_ARTIFACT",
  "REPO_ARTIFACT_ESCAPE",
  "LOCAL_MODEL_LOCAL_RUN",
  "LOCAL_MODEL_REMOTE_RUN",
  "LOCAL_MODEL_PROMPT_MISMATCH",
  "LOCAL_MODEL_COST_OK",
  "LOCAL_MODEL_COST_SUSPICIOUS",
  "LOCAL_MODEL_COST_UNKNOWN",
  "LOCAL_MODEL_TOKEN_ACCOUNTING",
  "LOCAL_MODEL_TOKEN_MISMATCH",
  "LOCAL_MODEL_TOKEN_UNKNOWN",
  "LOCAL_MODEL_IDENTITY_DECLARED",
  "LOCAL_MODEL_IDENTITY_UNKNOWN",
  "LOCAL_MODEL_IDENTITY_MISSING",
  "STAMINA_MULTISTEP_OBSERVED",
  "STAMINA_MULTISTEP_LIMITED_OBSERVABILITY",
  "STAMINA_MULTISTEP_MISSING",
  "STAMINA_BOUNDED_RETRY",
  "STAMINA_RETRY_UNBOUNDED",
  "STAMINA_STOP_CLEAN",
  "STAMINA_STOP_FAILED",
  "STAMINA_LONG_PROMPT_HANDLED",
  "STAMINA_LONG_PROMPT_FAILED",
] as const;

export function trialVerdictCopy(trial: Pick<TrialSummary, "verdict" | "passCount" | "testCount">): {
  headline: string;
  sub: string;
} {
  if (trial.verdict === "pass") {
    return {
      headline: "Crowned",
      sub: "All required checks in this run passed. Read the receipts for the exact scope.",
    };
  }
  if (trial.verdict === "fail") {
    const partialPass = trial.passCount > 0;
    return {
      headline: partialPass ? "Blocked" : "Rejected",
      sub: partialPass
        ? "Some checks passed, but at least one fail-level receipt blocks trust. The pass count is partial evidence, not a clean result."
        : "No passing evidence cleared the blocking checks. Read the receipts for every reason.",
    };
  }
  if (trial.verdict === "warn") {
    return {
      headline: "Marked",
      sub: "Not blocked, but one or more receipts are partial, unknown, or no-evidence. Inspect categories before trusting the score.",
    };
  }
  if (trial.verdict === "error") {
    return {
      headline: "Interrupted",
      sub: "An error stopped the trial. Treat this as infrastructure or runner evidence until receipts prove otherwise.",
    };
  }
  return { headline: "Empty", sub: "No tests ran." };
}

export function failureTypeLabel(failureType?: string): string | undefined {
  switch (failureType) {
    case "no_evidence":
      return "No evidence";
    case "infrastructure_failure":
    case "adapter_setup_failed":
      return "Infrastructure/provider";
    case "timeout":
      return "Timeout";
    case "unsafe_action":
      return "Agent safety failure";
    case "wrong_output":
      return "Wrong output";
    case "silent_success":
      return "Silent success";
    case "scope_violation":
      return "Scope violation";
    case "tool_failure_hidden":
      return "Hidden tool failure";
    case "incomplete_execution":
      return "Incomplete execution";
    case "clarification_required":
      return "Clarification needed";
    case "no_output":
      return "No final answer";
    default:
      return failureType;
  }
}

export function receiptBadges(r: Pick<Receipt, "verdict" | "failureType" | "evaluationCategory">): string[] {
  return [
    String(r.verdict).toUpperCase(),
    ...(r.failureType ? [failureTypeLabel(r.failureType) ?? r.failureType] : []),
    ...(r.evaluationCategory ? [r.evaluationCategory] : []),
  ];
}

export function formatModelStatus(modelInfo: Receipt["modelInfo"]): {
  primary: string;
  detail: string;
  unknown: boolean;
} {
  const modelUnknown = !modelInfo.model || modelInfo.model === "unknown";
  const providerUnknown = !modelInfo.provider || modelInfo.provider === "unknown";
  const locationUnknown = !modelInfo.location || modelInfo.location === "unknown";
  const provider = providerUnknown ? "provider unknown" : modelInfo.provider;
  const model = modelUnknown ? "model unknown" : modelInfo.model;
  const location = locationUnknown ? "location unknown" : modelInfo.location;
  return {
    primary: `${provider} · ${model}`,
    detail: `${location}${modelInfo.location === "local" ? " (adapter-reported local)" : ""}${modelInfo.location === "cloud" ? " (adapter-reported cloud)" : ""}`,
    unknown: modelUnknown || providerUnknown || locationUnknown,
  };
}

export function formatCostStatus(costInfo: Receipt["costInfo"]): {
  primary: string;
  detail: string;
  unknown: boolean;
} {
  if (!costInfo.reported) {
    return {
      primary: "Cost not reported",
      detail: costInfo.note
        ? `${costInfo.note}; not value-comparable`
        : "adapter did not report cost; not value-comparable",
      unknown: true,
    };
  }
  return {
    primary: `$${(costInfo.estimatedCostUsd ?? 0).toFixed(4)}`,
    detail: `prompt=${costInfo.promptTokens ?? "?"} output=${costInfo.outputTokens ?? "?"} total=${costInfo.totalTokens ?? "?"}`,
    unknown: false,
  };
}

export function buildReceiptsJsonExport(trial: TrialSummary, receipts: Receipt[]): string {
  return JSON.stringify(
    {
      trialId: trial.trialId,
      verdict: trial.verdict,
      passCount: trial.passCount,
      testCount: trial.testCount,
      trust: trial.score.trust,
      receipts: receipts.map((r) => ({
        receiptId: r.receiptId,
        testId: r.testId,
        verdict: r.verdict,
        failureType: r.failureType ?? null,
        evaluationCategory: r.evaluationCategory ?? null,
        reasons: r.reasons,
        modelInfo: r.modelInfo,
        costInfo: r.costInfo,
        expectedBehavior: r.expectedBehavior,
        observedBehavior: r.observedBehavior,
        stdoutSummary: r.stdoutSummary,
        stderrSummary: r.stderrSummary,
      })),
    },
    null,
    2,
  );
}
