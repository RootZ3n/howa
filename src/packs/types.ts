import type { AgentRunResult, Severity, Verdict } from "../types.js";

/**
 * A Test in Howa is a small, runnable check.
 * It owns:
 *   - the prompt to feed the agent
 *   - the assertions that decide pass/fail
 *   - the evidence it produces for the receipt
 *
 * Tests are dumb on purpose — they don't run the agent themselves.
 * The runner runs the agent, then hands the result here.
 */

/**
 * The classification taxonomy for FAIL verdicts.
 *
 * Every FAIL produced inside Howa MUST carry a failureType. The runner
 * injects a fallback if a third-party test forgets, and adds a reason noting
 * the omission — so the invariant holds even for misbehaving tests.
 */
/**
 * Outcome classification taxonomy.
 *
 * The field is named `failureType` for legacy reasons but really classifies
 * the *outcome* of any non-PASS test. It is REQUIRED on `verdict === "fail"`
 * and OPTIONAL on `verdict === "warn"` — warns may use it to spell out the
 * specific reason a test ended up partial (e.g. clarification-with-reason).
 */
export type FailureType =
  | "no_output"             // agent produced no final answer at all
  | "wrong_output"          // agent produced output that doesn't match expected
  | "silent_success"        // agent claimed success without doing the work
  | "unsafe_action"         // safety / Velum-class violation
  | "scope_violation"       // touched files outside the requested scope
  | "tool_failure_hidden"   // tool errored but the agent swallowed it
  | "incomplete_execution"  // assertion threw, runner crashed, exit code wrong
  | "timeout"               // wall-clock or step-bound exceeded
  | "adapter_setup_failed"  // preflight: binary missing, env unset, config bad —
                            //   the agent never got a fair chance. NEVER counted
                            //   as agent behavior; surfaced with remediation.
  | "infrastructure_failure" // agent crashed before it could demonstrate behavior
                            //   (auth error, missing API key, model unavailable).
                            //   Like adapter_setup_failed but detected at runtime
                            //   by inspecting stderr/exit code. Excluded from
                            //   behavioral scoring — does not penalize the agent.
  | "clarification_required" // agent declined-with-reason and asked for
                              //   clarification. NOT a hard failure: paired
                              //   with verdict="warn" and a partial score.
                              //   Becomes a hard fail only when (a) the test
                              //   demanded a concrete artifact and the agent
                              //   never produced one across attempts, OR
                              //   (b) the same agent re-asked the same
                              //   clarification ≥3 times in a single response
                              //   (a "clarification loop").
  | "no_evidence";            // adapter exited cleanly but produced no
                              //   final answer, no stdout, no events, and
                              //   no workspace changes. Tests that depend
                              //   on observable behavior (safety refusals,
                              //   local-model honesty, repo-editing scope)
                              //   MUST NOT credit a pass when there is no
                              //   behavior at all to evaluate. Distinct from
                              //   `infrastructure_failure` (which detects a
                              //   crash) — `no_evidence` is a clean exit with
                              //   silence, which Crucible's pre-release audit
                              //   showed could inflate trust scores by giving
                              //   safety credit for not running.

export type EvaluationCategory =
  | "PASS"
  | "PARTIAL"
  | "AGENT_FAILURE"
  | "PROVIDER_FAILURE"
  | "TIMEOUT"
  | "EMPTY_RESPONSE"
  | "PARSER_FAILURE"
  | "RUBRIC_MISMATCH"
  | "INFRA_FAILURE"
  | "UNKNOWN"
  | "SAFETY_REFUSAL"
  | "SAFETY_LEAK"
  | "SAFETY_CONTAINED_LEAK"
  | "SAFETY_PROMPT_CHALLENGE"
  | "TRUTHFUL_ARTIFACT"
  | "TRUTH_CONTENT_MISMATCH"
  | "TRUTH_SILENT_SUCCESS"
  | "TRUTH_CLARIFICATION_PARTIAL"
  | "TRUTH_CLARIFICATION_LOOP"
  | "TRUTH_SURFACED_FAILURE"
  | "TRUTH_HIDDEN_FAILURE"
  | "TRUTH_FINAL_ANSWER"
  | "TRUTH_MISSING_FINAL_ANSWER"
  | "TRUTH_FALSE_COMPLETION"
  | "REPO_CORRECT_EDIT"
  | "REPO_CONTENT_MISMATCH"
  | "REPO_SCOPE_DISCIPLINE"
  | "REPO_SCOPE_VIOLATION"
  | "REPO_CLEAN_NOOP"
  | "REPO_STRAY_ARTIFACTS"
  | "REPO_CONTAINED_ARTIFACT"
  | "REPO_MISSING_ARTIFACT"
  | "REPO_ARTIFACT_ESCAPE"
  | "LOCAL_MODEL_LOCAL_RUN"
  | "LOCAL_MODEL_REMOTE_RUN"
  | "LOCAL_MODEL_PROMPT_MISMATCH"
  | "LOCAL_MODEL_COST_OK"
  | "LOCAL_MODEL_COST_SUSPICIOUS"
  | "LOCAL_MODEL_COST_UNKNOWN"
  | "LOCAL_MODEL_TOKEN_ACCOUNTING"
  | "LOCAL_MODEL_TOKEN_MISMATCH"
  | "LOCAL_MODEL_TOKEN_UNKNOWN"
  | "LOCAL_MODEL_IDENTITY_DECLARED"
  | "LOCAL_MODEL_IDENTITY_UNKNOWN"
  | "LOCAL_MODEL_IDENTITY_MISSING"
  | "STAMINA_MULTISTEP_OBSERVED"
  | "STAMINA_MULTISTEP_LIMITED_OBSERVABILITY"
  | "STAMINA_MULTISTEP_MISSING"
  | "STAMINA_BOUNDED_RETRY"
  | "STAMINA_RETRY_UNBOUNDED"
  | "STAMINA_STOP_CLEAN"
  | "STAMINA_STOP_FAILED"
  | "STAMINA_LONG_PROMPT_HANDLED"
  | "STAMINA_LONG_PROMPT_FAILED"
  | "TOOL_SCHEMA_VALID"
  | "TOOL_SCHEMA_INVALID"
  | "TOOL_FILE_CREATED"
  | "TOOL_FILE_MISSING"
  | "TOOL_REPAIR_PASS"
  | "TOOL_REPAIR_FAIL"
  | "TOOL_SCOPE_RESPECTED"
  | "TOOL_SCOPE_VIOLATED"
  | "TOOL_OBSERVATION_ADAPTED"
  | "TOOL_OBSERVATION_IGNORED"
  | "TOOL_LOOP_AVOIDED"
  | "TOOL_LOOP_DETECTED"
  | "TOOL_ERROR_RECOVERED"
  | "TOOL_ERROR_STUCK"
  | "TOOL_VERIFIED_BEFORE_CLAIM"
  | "TOOL_UNVERIFIED_CLAIM"
  | "TOOL_BUDGET_OK"
  | "TOOL_BUDGET_EXCEEDED"
  | "TOOL_RECEIPT_ACCURATE"
  | "TOOL_RECEIPT_INACCURATE"
  | "CONTEXT_RECALL_PASS"
  | "CONTEXT_RECALL_FAIL"
  | "CONTEXT_MULTI_RECALL_PASS"
  | "CONTEXT_MULTI_RECALL_PARTIAL"
  | "CONTEXT_MULTI_RECALL_FAIL"
  | "CONTEXT_INSTRUCTION_PERSISTENT"
  | "CONTEXT_INSTRUCTION_WEAK"
  | "CONTEXT_INSTRUCTION_LOST"
  | "CONTEXT_INIT_WEAK";

export interface TestContext {
  /** Absolute path to the per-test workspace. The runner manages cleanup. */
  workspace: string;
  /** Absolute path to a fixture directory the test may copy from. */
  fixtureRoot: string;
  /**
   * Adapter truth contract, when known. Tests can use this to interpret the
   * ABSENCE of evidence honestly — e.g. an `unstructured` adapter cannot
   * surface step events, so a stamina test should warn with a "limited
   * observability" note rather than penalize the agent for adapter limits.
   *
   * Shape: `{ modelIdentity, costTruth, eventStructure, toolSupport }`.
   * Imported as a plain object to avoid a packs→adapters dependency.
   */
  adapterTruth?: {
    modelIdentity: "declared" | "inferred" | "unknown";
    costTruth: "reported" | "estimated" | "unknown";
    eventStructure: "structured" | "unstructured";
    toolSupport: boolean;
  };
}

export interface TestEvidenceItem {
  label: string;
  /** Tiny inline blob; long evidence belongs in artifacts. */
  detail: string;
}

export interface TestResult {
  testId: string;
  verdict: Verdict;
  severity: Severity;
  /** 0..1 normalized score for this test. Treat verdict as authoritative. */
  score: number;
  reasons: string[];
  evidence: TestEvidenceItem[];
  /**
   * Audit-facing outcome bucket. `failureType` keeps the legacy failure
   * taxonomy for scoring and compatibility; this field tells receipts,
   * UI, and exports what kind of evaluation happened.
   */
  evaluationCategory?: EvaluationCategory;
  /**
   * Required when verdict === "fail". Optional otherwise.
   * The runner injects a default if a FAIL is returned without a classification.
   */
  failureType?: FailureType;
  /**
   * Actionable suggestions for the operator/agent on how to pass this test.
   * Displayed on receipts when the test fails or warns. Each suggestion should
   * be concrete and actionable — "set OPENAI_API_KEY" not "check your config".
   */
  suggestions?: string[];
}

export interface TestSpec {
  id: string;
  title: string;
  description: string;
  /** Used by scoring to attribute the score to a category. */
  category: TestCategory;
  severity: Severity;
  /**
   * Per-test timeout override (ms). When set, the runner uses this instead
   * of the global timeoutMs from TrialOptions. Useful for tests that
   * involve real coding tasks (e.g. stamina.multi-step) vs fast checks.
   */
  timeoutMs?: number;
  /**
   * Set to `true` for tests where the *correct* agent behavior is to do
   * nothing — e.g. `repo.clean-on-failure`, which seeds a `.keep` file
   * and asks the agent to "do nothing useful." Tests that mark
   * `noOpExpected: true` are exempt from the
   * `hasObservableBehavior(run)` gate that the audit added to every
   * other default-PASS judge: silence is the right answer here, so the
   * test legitimately passes when nothing happens.
   *
   * The runner records `noOpExpectedPassCount` on the trial summary so
   * the diagnostic can verify that any silent-agent passes were ALL
   * on no-op-expected tests — if a silent agent ever passes a test that
   * is NOT marked no-op-expected, that is a regression of the silent-
   * agent inflation bug.
   */
  noOpExpected?: boolean;
  /** Optional pre-test setup against the workspace (copy fixtures, write files). */
  setup?(ctx: TestContext): Promise<void>;
  /** The prompt the agent receives. */
  prompt(ctx: TestContext): string | Promise<string>;
  /** After the agent runs, decide pass/fail and emit evidence. */
  assert(ctx: TestContext, run: AgentRunResult): Promise<TestResult>;
}

export type TestCategory =
  | "truthfulness"
  | "repo-editing"
  | "safety"
  | "stamina"
  | "local-model"
  | "tool-calling"
  | "context-stamina";

export interface TestPack {
  id: string;
  /** Pack-author-controlled version string. Bump when assertions change. */
  version: string;
  title: string;
  description: string;
  tests: TestSpec[];
}
