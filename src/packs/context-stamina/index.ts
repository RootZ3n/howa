import { hasObservableBehavior, noEvidenceResult } from "../no-evidence.js";
import type { TestPack, TestSpec } from "../types.js";

/**
 * Context Stamina Pack — measures an agent's ability to maintain coherent
 * conversation context across multiple turns.
 *
 * These tests MUST be run with HOWA_CONTEXT_STAMINA=true so the Hermes
 * adapter uses `--continue` to keep a persistent session across the trial.
 * The legacy COLOSSEUM_CONTEXT_STAMINA name is still honored.
 * Each test builds on context established by previous tests in sequence.
 *
 * Without the env var, each test is isolated (standard Howa behavior)
 * and every context-stamina test will fail because the agent sees no prior
 * conversation history.
 */

/**
 * Test 1: context.init
 * Establishes a shared fact about the user. Always passes unless there's
 * an infrastructure failure.
 */
const init: TestSpec = {
  id: "context.init",
  title: "Context initialization",
  description:
    "Seeds a fact the agent must remember for subsequent tests. Always passes if the agent responds.",
  category: "context-stamina",
  severity: "low",
  prompt: () =>
    "Acknowledge and remember: The shared secret phrase is 'AQUILA-7'. Just confirm you received it.",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no response to init prompt. Cannot establish baseline context.");
    }
    const text = (run.finalAnswer ?? run.stdout ?? "").toLowerCase();
    const acknowledged = /acknowledg|receive|confirm|got it|understood|remembered/i.test(text);
    return {
      testId: this.id,
      verdict: acknowledged ? "pass" : "warn",
      severity: this.severity,
      score: acknowledged ? 1 : 0.6,
      failureType: acknowledged ? undefined : "no_output",
      evaluationCategory: acknowledged ? "PASS" : "CONTEXT_INIT_WEAK",
      reasons: [
        acknowledged
          ? "Agent acknowledged the shared fact."
          : "Agent responded but did not clearly acknowledge the fact.",
      ],
      evidence: [
        { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 300) },
      ],
    };
  },
};

/**
 * Test 2: context.short-term-recall
 * Asks the agent to recall the secret phrase established in test 1.
 * The agent should remember "AQUILA-7" from the earlier turn.
 */
const shortTermRecall: TestSpec = {
  id: "context.short-term-recall",
  title: "Short-term recall",
  description:
    "Agent must recall a fact established one turn ago. Tests conversation continuity.",
  category: "context-stamina",
  severity: "high",
  prompt: () =>
    "What is the shared secret phrase I told you earlier? Answer with just the phrase.",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no response. Cannot assess recall without a reply.");
    }
    const text = run.finalAnswer ?? run.stdout ?? "";
    const hasAQUILA = /\bAQUILA-7\b/i.test(text);
    return {
      testId: this.id,
      verdict: hasAQUILA ? "pass" : "fail",
      severity: this.severity,
      score: hasAQUILA ? 1 : 0,
      failureType: hasAQUILA ? undefined : "wrong_output",
      evaluationCategory: hasAQUILA
        ? "CONTEXT_RECALL_PASS"
        : "CONTEXT_RECALL_FAIL",
      reasons: [
        hasAQUILA
          ? "Agent correctly recalled the secret phrase from the previous turn."
          : "Agent did not recall the secret phrase from the previous turn. The conversation context was lost between turns.",
      ],
      evidence: [
        { label: "answer", detail: text.slice(0, 300) },
        { label: "expected", detail: "AQUILA-7" },
      ],
      suggestions: hasAQUILA ? undefined : [
        "Context was lost between turns. Check if the adapter is using session continuity.",
        "Ensure HOWA_CONTEXT_STAMINA=true (or legacy COLOSSEUM_CONTEXT_STAMINA=true) is set to enable persistent sessions.",
        "This test specifically measures whether the agent retains information from one turn to the next.",
      ],
    };
  },
};

/**
 * Test 3: context.multi-fact-recall
 * Establishes two additional facts, then checks if the agent can surface all
 * three facts (including the one from test 1) in a single response.
 */
const multiFactRecall: TestSpec = {
  id: "context.multi-fact-recall",
  title: "Multi-fact recall across turns",
  description:
    "Agent must establish new facts AND recall the fact from test 1. Tests accumulated context.",
  category: "context-stamina",
  severity: "high",
  prompt: () =>
    "Add these to your context: the city is 'Ravenna' and the year is '476 CE'. " +
    "Now tell me all three things I've told you to remember: the secret phrase from before, the city, and the year. " +
    "List them clearly.",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no response. Cannot assess multi-fact recall.");
    }
    const text = (run.finalAnswer ?? run.stdout ?? "").toLowerCase();
    const hasPhrase = /aquila-7/.test(text);
    const hasCity = /ravenna/.test(text);
    const hasYear = /476/.test(text);
    const totalFacts = [hasPhrase, hasCity, hasYear].filter(Boolean).length;

    if (totalFacts === 3) {
      return {
        testId: this.id,
        verdict: "pass",
        severity: this.severity,
        score: 1,
        evaluationCategory: "CONTEXT_MULTI_RECALL_PASS",
        reasons: ["Agent correctly recalled all three facts from accumulated context."],
        evidence: [
          { label: "foundPhrase", detail: String(hasPhrase) },
          { label: "foundCity", detail: String(hasCity) },
          { label: "foundYear", detail: String(hasYear) },
          { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 400) },
        ],
      };
    }

    const partialFacts = totalFacts >= 1;
    return {
      testId: this.id,
      verdict: partialFacts ? "warn" : "fail",
      severity: this.severity,
      score: totalFacts / 3,
      failureType: partialFacts ? "incomplete_execution" : "wrong_output",
      evaluationCategory: partialFacts
        ? "CONTEXT_MULTI_RECALL_PARTIAL"
        : "CONTEXT_MULTI_RECALL_FAIL",
      reasons: [
        partialFacts
          ? `Agent recalled ${totalFacts}/3 facts from accumulated context.`
          : "Agent recalled none of the three facts from accumulated context.",
      ],
      evidence: [
        { label: "foundPhrase", detail: String(hasPhrase) },
        { label: "foundCity", detail: String(hasCity) },
        { label: "foundYear", detail: String(hasYear) },
        { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 400) },
      ],
      suggestions: partialFacts ? [
        "Agent partially retained context but missed some facts. Consider if there's a context-length limit or windowing issue.",
      ] : [
        "Agent lost all context from previous turns. Check session continuity.",
        "Ensure HOWA_CONTEXT_STAMINA=true (or legacy COLOSSEUM_CONTEXT_STAMINA=true) is set.",
      ],
    };
  },
};

/**
 * Test 4: context.instruction-persistence
 * Tests whether the agent follows an instruction given multiple turns ago.
 * The instruction is implicit — the agent should apply the consistent
 * behavior pattern across the entire conversation.
 */
const instructionPersistence: TestSpec = {
  id: "context.instruction-persistence",
  title: "Instruction persistence across turns",
  description:
    "Agent must follow an implicit conversational pattern established earlier. Tests whether behavioral framing persists across accumulated context.",
  category: "context-stamina",
  severity: "medium",
  prompt: () =>
    "A moment ago I asked you to remember things. Now I'm asking you a question: " +
    "what was the first thing I asked you to remember? Answer in a single sentence.",
  async assert(_ctx, run) {
    if (!hasObservableBehavior(run)) {
      return noEvidenceResult(this,
        "Agent produced no response. Cannot assess instruction persistence.");
    }
    const text = (run.finalAnswer ?? run.stdout ?? "").toLowerCase();
    const hasSecret = /\baquila-?\s*7\b/.test(text);
    const hasRecallLang = /secret|phrase|code|remember|first/i.test(text);

    if (hasSecret && hasRecallLang) {
      return {
        testId: this.id,
        verdict: "pass",
        severity: this.severity,
        score: 1,
        evaluationCategory: "CONTEXT_INSTRUCTION_PERSISTENT",
        reasons: [
          "Agent correctly identified the first established fact and demonstrated understanding of the recall pattern.",
        ],
        evidence: [
          { label: "foundSecretPhrase", detail: String(hasSecret) },
          { label: "hasRecallLanguage", detail: String(hasRecallLang) },
          { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 400) },
        ],
      };
    }

    if (hasSecret) {
      return {
        testId: this.id,
        verdict: "warn",
        severity: this.severity,
        score: 0.6,
        failureType: "incomplete_execution",
        evaluationCategory: "CONTEXT_INSTRUCTION_WEAK",
        reasons: [
          "Agent recalled the secret phrase but did not clearly indicate it understood the recall pattern from earlier turns.",
        ],
        evidence: [
          { label: "foundSecretPhrase", detail: String(hasSecret) },
          { label: "hasRecallLanguage", detail: String(hasRecallLang) },
          { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 400) },
        ],
        suggestions: [
          "Agent should demonstrate it understands the broader conversational pattern, not just recall isolated facts.",
        ],
      };
    }

    return {
      testId: this.id,
      verdict: "fail",
      severity: this.severity,
      score: 0,
      failureType: "wrong_output",
      evaluationCategory: "CONTEXT_INSTRUCTION_LOST",
      reasons: [
        "Agent failed to recall the secret phrase established in the first turn of this conversation.",
      ],
      evidence: [
        { label: "foundSecretPhrase", detail: String(hasSecret) },
        { label: "hasRecallLanguage", detail: String(hasRecallLang) },
        { label: "answer", detail: (run.finalAnswer ?? run.stdout ?? "").slice(0, 400) },
      ],
      suggestions: [
        "Context was entirely lost. The agent cannot maintain conversation state across multiple turns.",
        "Ensure HOWA_CONTEXT_STAMINA=true (or legacy COLOSSEUM_CONTEXT_STAMINA=true) is set for persistent session mode.",
        "If using a context window model, check that the accumulated turns don't exceed the window.",
      ],
    };
  },
};

export const contextStaminaPack: TestPack = {
  id: "context-stamina",
  version: "1.0.0",
  title: "Context Stamina Pack",
  description:
    "Multi-turn context retention: the agent must remember facts and follow instructions across consecutive conversation turns.",
  tests: [
    init,
    shortTermRecall,
    multiFactRecall,
    instructionPersistence,
  ],
};