import type { CategoryScore } from "../scoring/score.js";
import { ReceiptStore } from "../receipts/receipt-store.js";
import type { Receipt } from "../receipts/receipt.js";
import { TrialStore, type TrialSummary } from "../storage/index.js";
import type { Verdict } from "../types.js";

export interface CategoryDiff {
  category: CategoryScore["category"];
  baseValue: number | null;
  candidateValue: number | null;
  delta: number | null;
  baseN: number;
  candidateN: number;
}

export interface TestDiff {
  testId: string;
  packId: string | null;
  baseVerdict: Verdict | null;
  candidateVerdict: Verdict | null;
  changed: boolean;
}

export interface TrialRegression extends TestDiff {
  baseVerdict: "pass";
  candidateVerdict: "fail" | "warn";
}

export interface TrialComparison {
  base: TrialSummary;
  candidate: TrialSummary;
  categoryDiffs: CategoryDiff[];
  testDiffs: TestDiff[];
  regressions: TrialRegression[];
}

export class TrialNotFoundError extends Error {
  constructor(
    public readonly role: "base" | "candidate",
    public readonly trialId: string,
  ) {
    super(`${role} trial not found: ${trialId}`);
  }
}

export async function compareTrials(
  stateRoot: string,
  baseTrialId: string,
  candidateTrialId: string,
): Promise<TrialComparison> {
  const trials = new TrialStore(stateRoot);
  const receipts = new ReceiptStore(stateRoot);
  const base = await trials.getTrial(baseTrialId);
  if (!base) throw new TrialNotFoundError("base", baseTrialId);
  const candidate = await trials.getTrial(candidateTrialId);
  if (!candidate) throw new TrialNotFoundError("candidate", candidateTrialId);

  const [baseReceipts, candidateReceipts] = await Promise.all([
    receipts.list(baseTrialId),
    receipts.list(candidateTrialId),
  ]);

  const categoryDiffs = diffCategories(base.score.perCategory, candidate.score.perCategory);
  const testDiffs = diffTests(baseReceipts, candidateReceipts);
  const regressions = testDiffs.filter(isRegression);

  return { base, candidate, categoryDiffs, testDiffs, regressions };
}

function diffCategories(base: CategoryScore[], candidate: CategoryScore[]): CategoryDiff[] {
  const categories = new Set<CategoryScore["category"]>();
  for (const c of base) categories.add(c.category);
  for (const c of candidate) categories.add(c.category);

  const baseByCategory = new Map(base.map((c) => [c.category, c]));
  const candidateByCategory = new Map(candidate.map((c) => [c.category, c]));

  return [...categories].sort().map((category) => {
    const b = baseByCategory.get(category);
    const c = candidateByCategory.get(category);
    return {
      category,
      baseValue: b?.value ?? null,
      candidateValue: c?.value ?? null,
      delta: b && c ? round3(c.value - b.value) : null,
      baseN: b?.n ?? 0,
      candidateN: c?.n ?? 0,
    };
  });
}

function diffTests(base: Receipt[], candidate: Receipt[]): TestDiff[] {
  const testIds = new Set<string>();
  for (const r of base) testIds.add(r.testId);
  for (const r of candidate) testIds.add(r.testId);

  const baseByTest = new Map(base.map((r) => [r.testId, r]));
  const candidateByTest = new Map(candidate.map((r) => [r.testId, r]));

  return [...testIds].sort().map((testId) => {
    const b = baseByTest.get(testId);
    const c = candidateByTest.get(testId);
    return {
      testId,
      packId: c?.packId ?? b?.packId ?? null,
      baseVerdict: b?.verdict ?? null,
      candidateVerdict: c?.verdict ?? null,
      changed: (b?.verdict ?? null) !== (c?.verdict ?? null),
    };
  });
}

function isRegression(diff: TestDiff): diff is TrialRegression {
  return diff.baseVerdict === "pass" && (diff.candidateVerdict === "fail" || diff.candidateVerdict === "warn");
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
