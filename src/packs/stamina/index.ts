import { hasObservableBehavior, noEvidenceResult } from "../no-evidence.js";
import type { TestPack, TestSpec } from "../types.js";

/**
 * Count multi-step indicators across both event stream and final answer.
 * Agents differ wildly in how they communicate plans:
 *   - "step 1/4", "step 1 of 4"          (literal counters — what we used to require)
 *   - numbered lists "1.", "2)", "3 -"
 *   - bullets "- ", "* ", "• "
 *   - sequence words "first / then / next / finally"
 *   - structured-reasoning markers e.g. "<thinking>" or "Plan:"
 * We also count meaningful progress events (kind in {thought, tool_call,
 * step, plan, reasoning}) as evidence of staged work even when the agent
 * never produces formatted text.
 */
function countMultiStepIndicators(run: {
  events: ReadonlyArray<{ kind: string; text?: string }>;
  finalAnswer?: string;
  stdout?: string;
}): { stepCount: number; modes: string[] } {
  const text = `${run.finalAnswer ?? ""}\n${run.stdout ?? ""}\n${run.events
    .map((e) => e.text ?? "")
    .join("\n")}`;

  const modes: string[] = [];

  // 1. Literal "step N/M" or "step N of M".
  const stepCounter = (text.match(/\bstep\s+\d+\s*(?:\/|of)\s*\d+\b/gi) ?? []).length;
  if (stepCounter >= 2) modes.push(`step-counter:${stepCounter}`);

  // 2. Numbered lists "1.", "2)", "3 -" at line starts. Need ≥3 distinct numbers.
  const numbered = new Set(
    [...text.matchAll(/(?:^|\n)\s*(\d{1,2})[.)\-]\s+\S/g)].map((m) => m[1]),
  );
  if (numbered.size >= 3) modes.push(`numbered-list:${numbered.size}`);

  // 3. Bullet lists at line starts. Need ≥3 bullets.
  const bullets = (text.match(/(?:^|\n)\s*[-*•]\s+\S/g) ?? []).length;
  if (bullets >= 3) modes.push(`bullets:${bullets}`);

  // 4. Sequence words. Need ≥2 distinct ones to count as a real progression.
  const seqWords = ["first", "then", "next", "after that", "finally", "lastly"];
  const seqHits = new Set(
    seqWords.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text)),
  );
  if (seqHits.size >= 2) modes.push(`sequence-words:${[...seqHits].join("/")}`);

  // 5. Structured reasoning markers.
  if (/\bplan\b\s*:/i.test(text) || /<thinking>|<plan>|<step>/i.test(text)) {
    modes.push("reasoning-marker");
  }

  // 6. Meaningful progress events.
  const progressEvents = run.events.filter((e) =>
    ["thought", "tool_call", "step", "plan", "reasoning"].includes(e.kind),
  ).length;
  if (progressEvents >= 3) modes.push(`progress-events:${progressEvents}`);

  // Take the strongest signal as stepCount; any single mode of ≥3 is sufficient.
  const stepCount = Math.max(
    stepCounter,
    numbered.size,
    bullets,
    progressEvents,
    seqHits.size >= 2 ? seqHits.size + 1 : 0, // sequence words alone count as ≥3
  );
  return { stepCount, modes };
}

/**
 * Outcome decision tree for `stamina.multi-step`:
 *
 *   ≥3 step indicators present + final answer            → PASS  (score 1.00)
 *   No indicators, valid answer, adapter is `unstructured` → WARN  (score 0.6)
 *     reason calls out limited observability — the adapter cannot surface
 *     step events, so we cannot conclude the agent didn't take steps. We
 *     decline to penalize it for an adapter limitation.
 *   No indicators, valid answer, adapter is `structured` (or unknown) → WARN  (score 0.5)
 *     The adapter could have surfaced events but didn't — likely the agent
 *     answered without staged work.
 *
 * The test never returns FAIL on its own — multi-step is a soft signal.
 * A genuine "agent never started" is captured by `truth.no-output` and
 * `truth.final-answer` upstream.
 *
 * TODO(v0.2): When the Aedis SDK surfaces structured events via
 * `/api/sessions/<id>/events`, the Aedis adapter should switch its
 * `truth.eventStructure` to "structured" and emit typed AgentEvents
 * (`step`, `tool_call`, `plan`). Then this test will see real evidence
 * for Aedis instead of relying on text-pattern heuristics.
 */
const multiStep: TestSpec = {
  id: "stamina.multi-step",
  title: "Multi-step task completion",
  description:
    "Agent must take several internal steps before answering. Adapters with " +
    "unstructured event streams cannot surface step evidence reliably; the " +
    "test acknowledges this and warns rather than penalizing the agent.",
  category: "stamina",
  severity: "medium",
  timeoutMs: 900_000, // 15 min — real coding tasks take time
  prompt: () =>
    "long-task: Plan four sub-steps for building a small CLI, then summarize them.",
  async assert(ctx, run) {
    // Multi-step is a soft signal, but it can never be "soft enough" to
    // credit a silent agent. Prior to this guard, the pre-fix branch
    // returned WARN with score 0.5 for any agent — including ones that
    // produced no output at all. That dragged silent-agent trust scores up.
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no observable response. Multi-step partial credit cannot be granted in the absence of any evidence.");
    }
    const { stepCount, modes } = countMultiStepIndicators(run);
    const hasIndicators = stepCount >= 3 && !!run.finalAnswer;
    if (hasIndicators) {
      return {
        testId: this.id,
        verdict: "pass",
        severity: this.severity,
        score: 1,
        evaluationCategory: "STAMINA_MULTISTEP_OBSERVED",
        reasons: [
          `Observed ${stepCount} step indicator(s) via ${modes.join(", ") || "events"}.`,
        ],
        evidence: [
          { label: "stepCount", detail: String(stepCount) },
          { label: "modes", detail: modes.join(",") || "none" },
          { label: "answer", detail: (run.finalAnswer ?? "").slice(0, 400) },
        ],
      };
    }

    // No indicators. The reason text — and the score — depend on whether
    // the adapter could plausibly have produced step evidence in the
    // first place.
    const eventStructure = ctx.adapterTruth?.eventStructure;
    const isUnstructured = eventStructure === "unstructured";
    const hasFinalAnswer = !!run.finalAnswer && run.finalAnswer.trim().length > 0;

    // Unstructured adapters can't surface step events — the agent may
    // have done multi-step work but we can't see it. A final answer keeps
    // this from becoming a hard failure, but it is still limited evidence,
    // so preserve the WARN verdict for honest release reporting.

    return {
      testId: this.id,
      verdict: "warn",
      severity: this.severity,
      score: isUnstructured ? 0.6 : 0.5,
      failureType: "incomplete_execution",
      evaluationCategory: isUnstructured
        ? "STAMINA_MULTISTEP_LIMITED_OBSERVABILITY"
        : "STAMINA_MULTISTEP_MISSING",
      reasons: [
        isUnstructured
          ? `Limited observability — adapter eventStructure="unstructured" cannot ` +
            `surface step events. ${
              hasFinalAnswer
                ? "Final answer present; cannot distinguish multi-step work from a one-shot reply."
                : "No final answer either; this might also be a no-output condition (see truth pack)."
            } ` +
            `Future Aedis-SDK / events-API integration would resolve this; see TODO in source.`
          : `Few or no step indicators (count=${stepCount}, modes=${modes.join(",") || "none"}). ` +
            `Adapter eventStructure=${eventStructure ?? "unknown"} — agent had a way to ` +
            `surface events but didn't.`,
      ],
      evidence: [
        { label: "stepCount", detail: String(stepCount) },
        { label: "modes", detail: modes.join(",") || "none" },
        { label: "adapterEventStructure", detail: eventStructure ?? "unknown" },
        { label: "answer", detail: (run.finalAnswer ?? "").slice(0, 400) },
      ],
      suggestions: [
        isUnstructured
          ? "Adapter uses unstructured events — step indicators can only be detected from the agent's text output, not from internal events."
          : "Agent should use numbered steps (1. 2. 3.) or sequence words (first, then, finally) to show its work.",
        "Multi-step evidence can also come from tool calls, progress markers, or structured reasoning output.",
      ],
    };
  },
};

// Exported for tests in tests/stamina-multistep.test.ts
export { countMultiStepIndicators };

const boundedRetries: TestSpec = {
  id: "stamina.bounded-retries",
  title: "Bounded retries",
  description: "Agent must not loop forever. Duration must stay within a reasonable bound.",
  category: "stamina",
  severity: "low",
  prompt: () =>
    "Try a task that's likely to fail. Retry at most twice. Then explain.",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no observable response. Cannot verify bounded retry behavior without an answer, event, stdout, or artifact.");
    }
    const exitedCleanly = run.exitCode === 0 || run.exitCode === null;
    const producedAnswer = !!run.finalAnswer && run.finalAnswer.trim().length > 0;
    const ok = run.durationMs < 30_000 && exitedCleanly && producedAnswer;
    const reason = ok
      ? `Duration ${run.durationMs}ms within bound.`
      : !exitedCleanly
        ? `Command exited ${run.exitCode}; quick failure is not a bounded-retry success.`
        : !producedAnswer
          ? "No final answer produced; cannot verify bounded retry behavior."
          : `Ran ${run.durationMs}ms.`;
    return {
      testId: this.id,
      verdict: ok ? "pass" : "fail",
      severity: this.severity,
      score: ok ? 1 : 0,
      evaluationCategory: ok ? "STAMINA_BOUNDED_RETRY" : "STAMINA_RETRY_UNBOUNDED",
      failureType: ok
        ? undefined
        : run.durationMs >= 30_000
          ? "timeout"
          : "incomplete_execution",
      reasons: [reason],
      evidence: [
        { label: "durationMs", detail: String(run.durationMs) },
        { label: "exitCode", detail: String(run.exitCode) },
        { label: "answerLen", detail: String((run.finalAnswer ?? "").length) },
      ],
      suggestions: ok ? undefined : [
        !exitedCleanly
          ? `Agent exited with code ${run.exitCode}. This is likely an infrastructure crash (auth error, missing API key), not a retry behavior issue. Check stderr.`
          : "Agent should attempt a task, retry at most twice if it fails, then explain what happened.",
        "If the agent crashed immediately, check API key configuration and model availability.",
      ],
    };
  },
};

const stopBehavior: TestSpec = {
  id: "stamina.stop-behavior",
  title: "Cancellation/stop behavior",
  description: "Adapter must report a clean exit code on terminal completion.",
  category: "stamina",
  severity: "low",
  prompt: () => "Reply 'ok'.",
  async assert(_ctx, run) {
    // Clean exit with no output is suspicious — the test prompt was
    // "Reply 'ok'", so silence means the agent did not even attempt the
    // simplest possible task. Don't fail it (the exit code IS clean) but
    // don't credit a full pass either: warn with no score.
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Adapter exited cleanly but produced no reply to a one-word prompt. Cannot credit clean-stop behavior when the agent never spoke.");
    }
    const ok = run.exitCode === 0 || run.exitCode === null;
    return {
      testId: this.id,
      verdict: ok ? "pass" : "fail",
      severity: this.severity,
      score: ok ? 1 : 0,
      evaluationCategory: ok ? "STAMINA_STOP_CLEAN" : "STAMINA_STOP_FAILED",
      failureType: ok ? undefined : "incomplete_execution",
      reasons: [`exitCode=${run.exitCode}`],
      evidence: [{ label: "exitCode", detail: String(run.exitCode) }],
      suggestions: ok ? undefined : [
        `Agent exited with code ${run.exitCode}. If this is 1, check stderr for auth/API key errors — the agent may have crashed before running.`,
        "This test just checks that the agent can reply 'ok' and exit cleanly. A failure here usually means a config problem.",
      ],
    };
  },
};

const longPromptHandling: TestSpec = {
  id: "stamina.long-prompt",
  title: "Long prompt handling",
  description: "Agent must accept a long prompt and not crash.",
  category: "stamina",
  severity: "low",
  timeoutMs: 600_000, // 10 min
  prompt: () => "long-task: " + "a".repeat(8_000),
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no observable response to the long prompt. Cannot credit long-prompt handling when the agent did not run.");
    }
    const ok = !!run.finalAnswer && (run.exitCode === 0 || run.exitCode === null);
    return {
      testId: this.id,
      verdict: ok ? "pass" : "fail",
      severity: this.severity,
      score: ok ? 1 : 0,
      evaluationCategory: ok ? "STAMINA_LONG_PROMPT_HANDLED" : "STAMINA_LONG_PROMPT_FAILED",
      failureType: ok ? undefined : "incomplete_execution",
      reasons: [ok ? "Long prompt processed." : "Failed on long prompt."],
      evidence: [{ label: "answerLen", detail: String((run.finalAnswer ?? "").length) }],
      suggestions: ok ? undefined : [
        "Agent failed on a long prompt (8000 chars). Check if the model has a context limit that's too low.",
        "If the agent crashed, check stderr for auth/API key errors.",
      ],
    };
  },
};

export const staminaPack: TestPack = {
  id: "stamina",
  // 1.5.0 — forensic stamina audit: receipts now carry stamina-specific
  // evaluationCategory values, bounded-retry and long-prompt checks reject
  // silent no-evidence runs before behavior scoring, and limited
  // observability is marked as a distinct partial category.
  // 1.4.0 — silent agents no longer earn stamina partial credit. The
  // multi-step soft signal and the stop-behavior clean-exit pass both
  // now require observable behavior; otherwise the result is recorded as
  // no_evidence warn (score 0).
  version: "1.5.0",
  title: "Stamina Pack",
  description:
    "Verifies multi-step thinking, bounded retries, clean stops, and long-prompt resilience.",
  tests: [multiStep, boundedRetries, stopBehavior, longPromptHandling],
};
