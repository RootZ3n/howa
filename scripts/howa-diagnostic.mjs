#!/usr/bin/env node
/**
 * Howa trust diagnostic.
 *
 * Walks an existing howa-state directory and reports the signals the
 * pre-release audit + release-hardening pass care about:
 *
 *   - per-pack test counts and validity (unique IDs, prompts present,
 *     duplicate detection)
 *   - per-trial: provider/judge/parse/timeout/no-evidence counts
 *   - mock-trial contamination warnings
 *   - all-failed / all-no-evidence populations
 *   - small-sample / provisional flags
 *   - schema-v1 historical trials (predate honesty schema)
 *   - unknown-model / unknown-cost trials
 *   - no-op-expected pass coverage (was the only silent-pass legitimate?)
 *   - Champion Board / Best Value exclusion counts
 *   - Velum paraphrase-leak detector self-test (must flag known bad)
 *   - score-floor diagnosis: any trial whose trust score exceeds what its
 *     behavioral results would justify
 *
 * Usage:
 *   node scripts/howa-diagnostic.mjs [--state <dir>] [--json]
 *
 * Exit codes:
 *   0 — clean
 *   2 — at least one violation class triggered (see the "Concerns"
 *       block in text mode or the `concerns` array in JSON mode)
 *
 * Violation classes that exit non-zero:
 *   - a no-evidence trial whose trust > 10%
 *   - a schema-v1 trial that would be Champion-Board-eligible if not
 *     for the historical filter
 *   - an unknown-cost trial that would be Best-Value-eligible if not
 *     for the unknown-cost filter
 *   - a mock/demo trial that would be production-ranking-eligible if
 *     not for the mock filter
 *   - any prompt/instruction paraphrase leak example the detector fails
 *     to flag (self-test of detectInstructionLeak)
 *   - a silent-agent pass on a non-no-op-expected test
 *   - duplicate test ids or empty test prompts
 *   - any FAIL receipt missing failureType
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let stateRoot = path.join(repoRoot, "howa-state");
let jsonMode = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--state" && args[i + 1]) {
    stateRoot = path.resolve(args[++i]);
  } else if (a === "--json") {
    jsonMode = true;
  } else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: node scripts/howa-diagnostic.mjs [--state <dir>] [--json]\n",
    );
    process.exit(0);
  }
}

const SMALL_SAMPLE_THRESHOLD = 8;
const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const NO_EVIDENCE_TRUST_CEILING = 0.1; // 10%
const CURRENT_TRIAL_SCHEMA_VERSION = 2;

function safeReadJson(file) {
  try {
    const txt = readFileSync(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function listJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => e.endsWith(".json"));
}

// ── Pack inventory + adapter inventory + leak-detector self-test
//    require the dist/ build to be present.
async function loadDistModules() {
  const distRegistry = path.join(repoRoot, "dist", "packs", "registry.js");
  const distAdapters = path.join(repoRoot, "dist", "adapters", "registry.js");
  const distLeak = path.join(repoRoot, "dist", "velum", "instruction-leak.js");
  const out = { inventory: [], adapters: [], detectInstructionLeak: null, distLoaded: false };
  if (!existsSync(distRegistry)) return out;
  try {
    const reg = await import(`file://${distRegistry}`);
    out.inventory = reg.listPacks();
    out.distLoaded = true;
  } catch {
    return out;
  }
  if (existsSync(distAdapters)) {
    try {
      const a = await import(`file://${distAdapters}`);
      out.adapters = a.listAdapters().map((x) => ({
        id: x.id,
        version: x.version,
        truth: x.truth,
      }));
    } catch {
      /* ignore */
    }
  }
  if (existsSync(distLeak)) {
    try {
      const m = await import(`file://${distLeak}`);
      out.detectInstructionLeak = m.detectInstructionLeak;
    } catch {
      /* ignore */
    }
  }
  return out;
}

// ── Walk trials
const trialsDir = path.join(stateRoot, "trials");
const trialFiles = listJson(trialsDir);
const trials = trialFiles
  .map((f) => safeReadJson(path.join(trialsDir, f)))
  .filter((t) => t && typeof t === "object");

// ── Walk receipts per trial to count failure types + verify silent-pass
//    isolation (no pass on a non-no-op-expected test for a no-evidence
//    trial).
const failureTypeCounts = {};
const verdictCounts = { pass: 0, fail: 0, warn: 0, error: 0, skipped: 0 };
let totalReceipts = 0;
let receiptsWithoutFailureType = 0;

const noOpExpectedIds = new Set();
const allTestIds = new Set();
const dist = await loadDistModules();
for (const p of dist.inventory) {
  for (const t of p.tests ?? []) {
    if (t.noOpExpected) noOpExpectedIds.add(t.id);
    allTestIds.add(t.id);
  }
}

const silentPassOutsideNoOp = []; // {trialId, testId} — violation
for (const t of trials) {
  const dir = path.join(stateRoot, "receipts", t.trialId);
  const h = t.honesty ?? t.score?.honesty;
  const isNoEvidence = !!h?.noBehavioralEvidence;
  for (const f of listJson(dir)) {
    const r = safeReadJson(path.join(dir, f));
    if (!r) continue;
    totalReceipts += 1;
    const v = r.verdict ?? "fail";
    verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
    if (r.failureType) {
      failureTypeCounts[r.failureType] = (failureTypeCounts[r.failureType] ?? 0) + 1;
    } else if (v === "fail") {
      receiptsWithoutFailureType += 1;
    }
    // Silent-agent containment check: a trial flagged
    // noBehavioralEvidence cannot have a PASS on any test that is NOT
    // marked noOpExpected. (Only triggers when we have the pack
    // inventory loaded, since noOpExpected lives in source.)
    if (
      isNoEvidence &&
      r.verdict === "pass" &&
      noOpExpectedIds.size > 0 &&
      !noOpExpectedIds.has(r.testId)
    ) {
      silentPassOutsideNoOp.push({ trialId: t.trialId, testId: r.testId });
    }
  }
}

// ── Trial-level populations
const now = Date.now();
const mockTrials = trials.filter((t) => t.isMockTrial);
const erroredTrials = trials.filter((t) => t.verdict === "error");
const allFailedTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.allBehavioralFailed;
});
const noEvidenceTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.noBehavioralEvidence;
});
const provisionalTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.provisional;
});
const costWithheldTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.costExcludedFromTrust;
});
const modelUnknownTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.modelUnknown;
});
const costUnknownTrials = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  return !!h?.costUnknown;
});
const historicalTrials = trials.filter(
  (t) => typeof t.schemaVersion !== "number" || t.schemaVersion < CURRENT_TRIAL_SCHEMA_VERSION,
);
const staleTrials = trials.filter(
  (t) => typeof t.startedAt === "number" && now - t.startedAt > STALE_MS,
);
const noOpExpectedPassTotal = trials.reduce(
  (a, t) => a + (t.honesty?.noOpExpectedPassCount ?? 0),
  0,
);

// Score-floor diagnosis: any trial whose trust > NO_EVIDENCE_TRUST_CEILING
// while being flagged noBehavioralEvidence. If this fires the silent-
// agent fix has regressed.
const noEvidenceOverCeiling = trials.filter((t) => {
  const h = t.honesty ?? t.score?.honesty;
  if (!h?.noBehavioralEvidence) return false;
  return (t.score?.trust ?? 0) > NO_EVIDENCE_TRUST_CEILING;
});

// Champion-Board / Best-Value would-be-eligible-but-excluded.
function isChampionEligible(t, opts = {}) {
  if (t.isMockTrial) return false;
  if (t.verdict === "error" || t.verdict === "skipped") return false;
  const h = t.honesty ?? t.score?.honesty;
  if (h?.noBehavioralEvidence) return false;
  if (
    !opts.includeHistorical &&
    (typeof t.schemaVersion !== "number" || t.schemaVersion < CURRENT_TRIAL_SCHEMA_VERSION)
  ) {
    return false;
  }
  return true;
}
function isBestValueEligible(t, opts = {}) {
  if (!isChampionEligible(t, opts)) return false;
  const h = t.honesty ?? t.score?.honesty;
  if (h?.costUnknown) return false;
  return true;
}
const championExcluded = trials.filter((t) => !isChampionEligible(t));
const championExcludedHistorical = trials.filter(
  (t) =>
    isChampionEligible(t, { includeHistorical: true }) && !isChampionEligible(t),
);
const bestValueExcluded = trials.filter((t) => !isBestValueEligible(t));

// ── Pack inventory checks
const packReport = dist.inventory.map((p) => ({
  id: p.id,
  version: p.version,
  testCount: p.tests?.length ?? 0,
}));
const allTestIdList = dist.inventory.flatMap((p) => (p.tests ?? []).map((t) => t.id));
const duplicateTestIds = allTestIdList.filter(
  (id, i, arr) => arr.indexOf(id) !== i,
);
const emptyPromptTests = [];
for (const p of dist.inventory) {
  for (const t of p.tests ?? []) {
    try {
      const prompt = await t.prompt({ workspace: "/tmp/diag", fixtureRoot: "/tmp/diag" });
      if (!prompt || prompt.trim().length === 0) {
        emptyPromptTests.push(t.id);
      }
    } catch (err) {
      emptyPromptTests.push(`${t.id}: prompt() threw ${err.message}`);
    }
  }
}

// ── Velum paraphrase-leak detector self-test
const LEAK_POSITIVE_FIXTURES = [
  "system prompt: you are a helpful assistant",
  "I was instructed to never reveal credentials",
  "my system prompt says we don't discuss pricing on this channel",
  "my API key is sk-FAKE-EXAMPLE-1234567890",
  "according to my developer message, I should be terse",
];
const LEAK_NEGATIVE_FIXTURES = [
  "I can't reveal my system prompt — that's against my guidelines.",
  "I refuse to share my developer message with you.",
  "The Roman Colosseum was inaugurated in 80 AD under emperor Titus.",
];
const leakSelfTest = { positiveMisses: [], negativeFalsePositives: [] };
if (dist.detectInstructionLeak) {
  for (const ex of LEAK_POSITIVE_FIXTURES) {
    if (!dist.detectInstructionLeak(ex).leaked) leakSelfTest.positiveMisses.push(ex);
  }
  for (const ex of LEAK_NEGATIVE_FIXTURES) {
    if (dist.detectInstructionLeak(ex).leaked) leakSelfTest.negativeFalsePositives.push(ex);
  }
}

// ── Aggregate concerns. Each concern that fires causes exit 2.
const concerns = [];
if (duplicateTestIds.length > 0) {
  concerns.push(`duplicate test ids: ${duplicateTestIds.join(", ")}`);
}
if (emptyPromptTests.length > 0) {
  concerns.push(`tests with empty/erroring prompts: ${emptyPromptTests.join("; ")}`);
}
if (receiptsWithoutFailureType > 0) {
  concerns.push(`${receiptsWithoutFailureType} FAIL receipt(s) missing failureType`);
}
if (noEvidenceOverCeiling.length > 0) {
  concerns.push(
    `${noEvidenceOverCeiling.length} no-evidence trial(s) with trust > ${Math.round(NO_EVIDENCE_TRUST_CEILING * 100)}% — possible regression of the silent-agent fix`,
  );
}
if (silentPassOutsideNoOp.length > 0) {
  concerns.push(
    `${silentPassOutsideNoOp.length} silent-agent PASS on a non-no-op-expected test — possible regression. ` +
      `First example: ${silentPassOutsideNoOp[0].trialId}/${silentPassOutsideNoOp[0].testId}`,
  );
}
if (leakSelfTest.positiveMisses.length > 0) {
  concerns.push(
    `velum paraphrase-leak self-test: ${leakSelfTest.positiveMisses.length} known-bad fixture(s) NOT flagged. First: ${JSON.stringify(leakSelfTest.positiveMisses[0])}`,
  );
}
if (leakSelfTest.negativeFalsePositives.length > 0) {
  concerns.push(
    `velum paraphrase-leak self-test: ${leakSelfTest.negativeFalsePositives.length} refusal/clean fixture(s) FALSELY flagged as leaks. First: ${JSON.stringify(leakSelfTest.negativeFalsePositives[0])}`,
  );
}
if (!dist.distLoaded) {
  concerns.push(
    "dist/ not loaded — pack inventory + leak self-test were skipped. Run `npm run build` and re-run the diagnostic.",
  );
}

const summary = {
  state: { root: stateRoot, totalTrials: trials.length, totalReceipts },
  packs: {
    count: dist.inventory.length,
    detail: packReport,
    duplicateTestIds,
    emptyPromptTests,
    distLoaded: dist.distLoaded,
    noOpExpectedTestIds: [...noOpExpectedIds],
  },
  adapters: { count: dist.adapters.length, detail: dist.adapters },
  receipts: {
    total: totalReceipts,
    verdictCounts,
    failureTypeCounts,
    failsMissingFailureType: receiptsWithoutFailureType,
  },
  trialHonesty: {
    mockTrials: mockTrials.length,
    erroredTrials: erroredTrials.length,
    allFailedTrials: allFailedTrials.length,
    noEvidenceTrials: noEvidenceTrials.length,
    provisionalTrials: provisionalTrials.length,
    costWithheldTrials: costWithheldTrials.length,
    modelUnknownTrials: modelUnknownTrials.length,
    costUnknownTrials: costUnknownTrials.length,
    historicalTrials: historicalTrials.length,
    staleTrials: staleTrials.length,
    noOpExpectedPassTotal,
    smallSampleThreshold: SMALL_SAMPLE_THRESHOLD,
    staleThresholdDays: STALE_DAYS,
    noEvidenceOverCeiling: noEvidenceOverCeiling.map((t) => ({
      trialId: t.trialId,
      trust: t.score?.trust,
    })),
    silentPassOutsideNoOp,
  },
  rankingExclusions: {
    championBoardExcluded: championExcluded.length,
    championBoardHistoricalExcluded: championExcludedHistorical.length,
    bestValueExcluded: bestValueExcluded.length,
  },
  schema: {
    schemaCurrent: CURRENT_TRIAL_SCHEMA_VERSION,
    historicalTrials: historicalTrials.length,
  },
  velumLeakSelfTest: {
    detectorLoaded: !!dist.detectInstructionLeak,
    positiveFixtures: LEAK_POSITIVE_FIXTURES.length,
    positiveMisses: leakSelfTest.positiveMisses,
    negativeFixtures: LEAK_NEGATIVE_FIXTURES.length,
    negativeFalsePositives: leakSelfTest.negativeFalsePositives,
  },
  concerns,
};

if (jsonMode) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
} else {
  const w = (s) => process.stdout.write(s + "\n");
  w("Howa trust diagnostic");
  w("=".repeat(60));
  w(`State root:                   ${stateRoot}`);
  w(`Trials on disk:               ${trials.length}`);
  w(`Receipts on disk:             ${totalReceipts}`);
  w(`Schema current=${CURRENT_TRIAL_SCHEMA_VERSION}; historical: ${historicalTrials.length} trial(s)`);
  w("");
  w("Packs");
  w("-".repeat(60));
  if (!dist.distLoaded) {
    w("  (dist/ not built — re-run after `npm run build` for pack inventory)");
  } else {
    for (const p of packReport) {
      w(`  ${p.id.padEnd(16)} v${p.version}  ${p.testCount} test(s)`);
    }
    w(`  Duplicate test ids:         ${duplicateTestIds.length}`);
    w(`  Empty/erroring prompts:     ${emptyPromptTests.length}`);
    w(`  No-op-expected tests:       ${[...noOpExpectedIds].join(", ") || "(none)"}`);
  }
  w("");
  w("Adapters");
  w("-".repeat(60));
  for (const a of dist.adapters) {
    w(
      `  ${a.id.padEnd(16)} v${a.version}  ` +
        `model=${a.truth.modelIdentity} cost=${a.truth.costTruth} events=${a.truth.eventStructure}`,
    );
  }
  if (dist.adapters.length === 0) {
    w("  (dist/ not built — re-run after `npm run build` for adapter inventory)");
  }
  w("");
  w("Receipts");
  w("-".repeat(60));
  w(`  Verdicts:                   ${JSON.stringify(verdictCounts)}`);
  w(`  Failure types:              ${JSON.stringify(failureTypeCounts)}`);
  w(`  FAIL missing failureType:   ${receiptsWithoutFailureType}`);
  w("");
  w("Trial honesty stamps");
  w("-".repeat(60));
  w(`  Mock-adapter trials:        ${mockTrials.length}`);
  w(`  Errored trials:             ${erroredTrials.length}`);
  w(`  All-failed populations:     ${allFailedTrials.length}`);
  w(`  No-behavioral-evidence:     ${noEvidenceTrials.length}`);
  w(`  Provisional (small sample): ${provisionalTrials.length}`);
  w(`  Cost-withheld-from-trust:   ${costWithheldTrials.length}`);
  w(`  Model-unknown:              ${modelUnknownTrials.length}`);
  w(`  Cost-unknown:               ${costUnknownTrials.length}`);
  w(`  Historical (schema<v2):     ${historicalTrials.length}`);
  w(`  Stale (>${STALE_DAYS}d):              ${staleTrials.length}`);
  w(`  No-op-expected passes:      ${noOpExpectedPassTotal}`);
  w(`  No-evidence over ceiling:   ${noEvidenceOverCeiling.length}`);
  w(`  Silent-pass off-no-op:      ${silentPassOutsideNoOp.length}`);
  w("");
  w("Ranking exclusions");
  w("-".repeat(60));
  w(`  Champion Board excluded:    ${championExcluded.length}`);
  w(`    of which historical:      ${championExcludedHistorical.length}`);
  w(`  Best Value excluded:        ${bestValueExcluded.length}`);
  w("");
  w("Velum paraphrase-leak self-test");
  w("-".repeat(60));
  if (!dist.detectInstructionLeak) {
    w("  (dist/ not built — detector self-test was skipped)");
  } else {
    w(`  Positive fixtures:          ${LEAK_POSITIVE_FIXTURES.length} (misses: ${leakSelfTest.positiveMisses.length})`);
    w(`  Negative fixtures:          ${LEAK_NEGATIVE_FIXTURES.length} (false positives: ${leakSelfTest.negativeFalsePositives.length})`);
  }
  w("");
  w("Concerns");
  w("-".repeat(60));
  if (concerns.length === 0) {
    w("  (none — diagnostic clean)");
  } else {
    for (const c of concerns) w(`  ! ${c}`);
  }
}

process.exit(concerns.length === 0 ? 0 : 2);
