/**
 * Effective adapter truth resolver.
 *
 * Background:
 *   Adapters declare a static truth contract — `modelIdentity`, `costTruth`,
 *   `eventStructure`, `toolSupport`. Most CLI-wrapping adapters (Aedis,
 *   OpenClaw, Hermes, BetterClaw, generic-cli) honestly admit
 *   `modelIdentity=unknown` and `costTruth=unknown` because they cannot
 *   introspect the model or cost from a subprocess they merely shell out to.
 *
 *   That is *truthful* but it leaves the receipt blank for operators who
 *   actually know the model name and want to record it. The release-
 *   hardening pass adds operator-supplied overrides (`--model`,
 *   `--provider`, `--cost-mode`, `--cost-source`) that flip the
 *   corresponding truth field from "unknown" to "declared"/"reported"/etc
 *   so the receipt reflects what the operator vouched for.
 *
 * Critical invariant:
 *   The resolver NEVER upgrades a truth contract beyond what the operator
 *   explicitly supplied. Adapters that honestly say "I don't know" still
 *   say so unless the operator typed in a value. The eventStructure and
 *   toolSupport fields are NEVER overridden — those are intrinsic adapter
 *   capabilities, not operator-supplied annotations.
 */

import type { AdapterTruthContract } from "./types.js";
import type { ModelLocation } from "../types.js";

/**
 * Operator-supplied overrides that can upgrade an adapter's truth
 * contract. Every field is optional; the resolver leaves the adapter's
 * native value untouched when the override is missing or empty.
 *
 *  - `model`            non-empty string flips modelIdentity → "declared"
 *  - `provider`         non-empty string flips modelIdentity → "declared"
 *                       (a model name without a provider is still useful;
 *                        either alone is enough to consider identity declared)
 *  - `costMode`
 *      "reported"   — operator vouches the underlying provider returns real
 *                     cost numbers (e.g. an OpenAI-billed run). costTruth →
 *                     "reported".
 *      "estimated"  — operator vouches the cost is being estimated client-
 *                     side. costTruth → "estimated".
 *      "free"       — operator vouches the run is genuinely free (local
 *                     model, mock). costTruth → "reported" with cost=0.
 *      "unknown"    — explicit no-op (back to "unknown").
 */
export interface OperatorTruthOverrides {
  model?: string;
  provider?: string;
  location?: ModelLocation;
  costMode?: "reported" | "estimated" | "free" | "unknown";
  /**
   * Free-form note: where did the operator's claim come from? Stored on
   * the receipt's costInfo.note when costMode="reported"|"estimated".
   */
  costSource?: string;
}

/**
 * Compute the effective truth contract for a trial. Pure function.
 *
 * Returned object is a copy of `base` with operator overrides applied;
 * `base` is not mutated.
 */
export function resolveEffectiveTruth(
  base: AdapterTruthContract,
  overrides: OperatorTruthOverrides | undefined,
): AdapterTruthContract {
  const out: AdapterTruthContract = { ...base };
  if (!overrides) return out;

  const hasModelClaim =
    (typeof overrides.model === "string" && overrides.model.trim().length > 0) ||
    (typeof overrides.provider === "string" && overrides.provider.trim().length > 0);

  // Identity upgrades from "unknown" → "declared" only when the operator
  // actually typed something. We never DOWNGRADE an adapter that already
  // declared identity itself (e.g. the mock adapter is "declared" by
  // construction; an operator override does not weaken that).
  if (hasModelClaim && out.modelIdentity === "unknown") {
    out.modelIdentity = "declared";
  }

  switch (overrides.costMode) {
    case "reported":
      // Operator vouches that the underlying provider returns real cost
      // numbers. We honor that — but only by upgrading from "unknown".
      // If the adapter already says "estimated", an operator claim of
      // "reported" upgrades it; if it already says "reported", the
      // override is a no-op.
      if (out.costTruth === "unknown" || out.costTruth === "estimated") {
        out.costTruth = "reported";
      }
      break;
    case "estimated":
      if (out.costTruth === "unknown") {
        out.costTruth = "estimated";
      }
      break;
    case "free":
      // "free" is a stronger claim than "reported" — the operator says
      // there is genuinely no cost. We mark costTruth="reported" so
      // downstream rankings can include this trial as "known cost" (and
      // unknown-cost trials cannot pretend to be in the same league).
      out.costTruth = "reported";
      break;
    case "unknown":
      // Explicit no-op — operator chose to say "I don't know either."
      break;
  }
  return out;
}

/**
 * Build the costInfo seed implied by an operator override. Returns a
 * partial CostInfo shape that adapters/runners can merge over the
 * adapter's native costInfo. Only "free" carries a concrete numeric
 * commitment; "reported" and "estimated" only adjust the `reported`
 * flag and the truth note.
 */
export function operatorCostSeed(
  overrides: OperatorTruthOverrides | undefined,
): {
  reported: boolean;
  estimatedCostUsd?: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  note?: string;
} | null {
  if (!overrides?.costMode) return null;
  switch (overrides.costMode) {
    case "free":
      return {
        reported: true,
        estimatedCostUsd: 0,
        note:
          overrides.costSource ??
          "operator-declared free run (e.g. local model, mock adapter)",
      };
    case "reported":
      return {
        reported: true,
        note:
          overrides.costSource ??
          "operator-declared cost-reported run",
      };
    case "estimated":
      return {
        reported: true,
        note:
          overrides.costSource ??
          "operator-declared client-side cost estimation",
      };
    case "unknown":
      return null;
  }
  return null;
}

/**
 * Extract operator overrides from the runner's `baseRunOptions`. The
 * runner forwards `extra` verbatim to adapters; operator overrides live
 * inside `extra` under stable, snake-case-friendly keys so HTTP/JSON
 * clients can use them without a CLI.
 */
export function operatorOverridesFrom(opts: {
  model?: string;
  location?: ModelLocation;
  extra?: Record<string, unknown>;
} | undefined): OperatorTruthOverrides | undefined {
  if (!opts) return undefined;
  const extra = (opts.extra ?? {}) as Record<string, unknown>;
  const provider = typeof extra.provider === "string" ? extra.provider : undefined;
  const costModeRaw = typeof extra.costMode === "string" ? extra.costMode : undefined;
  const costMode = (
    costModeRaw === "reported" ||
    costModeRaw === "estimated" ||
    costModeRaw === "free" ||
    costModeRaw === "unknown"
      ? costModeRaw
      : undefined
  ) as OperatorTruthOverrides["costMode"];
  const costSource = typeof extra.costSource === "string" ? extra.costSource : undefined;
  if (!opts.model && !provider && !costMode && !costSource && !opts.location) {
    return undefined;
  }
  return {
    model: opts.model,
    provider,
    location: opts.location,
    costMode,
    costSource,
  };
}
