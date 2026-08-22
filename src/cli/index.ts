#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { listAdapters, getAdapter } from "../adapters/registry.js";
import { listPacks, getPack } from "../packs/registry.js";
import { runTrial } from "../runner/trial-runner.js";
import { defaultStateRoot, TrialStore } from "../storage/index.js";
import { ReceiptStore } from "../receipts/receipt-store.js";
import { renderReceipt } from "../receipts/receipt.js";
import { compareTrials, TrialNotFoundError } from "../trials/compare.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { runDailyDriverSuite, type DailyDriverCandidate } from "../daily-driver/runner.js";
import { HERMES_DAILY_DRIVER_V1 } from "../daily-driver/suite.js";
import { validateReceipt, type DailyDriverReceiptV1 } from "../daily-driver/contract.js";
import { verifyReceiptEvidence } from "../daily-driver/evidence.js";

const INIT_STATE_ROOT_PROMPT_DEFAULT = "~/.howa";

const COMMON_AGENT_BINARIES: Array<{
  adapter: string;
  binary: string;
  env?: string;
}> = [
  { adapter: "mechanic", binary: "mechanic", env: "MECHANIC_BIN" },
  { adapter: "aedis", binary: "aedis", env: "AEDIS_BIN" },
  { adapter: "openclaw", binary: "openclaw" },
  { adapter: "hermes", binary: "hermes" },
  { adapter: "betterclaw", binary: "betterclaw" },
  { adapter: "artist", binary: "artist" },
  { adapter: "generic-cli", binary: "claude" },
  { adapter: "generic-cli", binary: "codex" },
];

const HONESTY_EXPLANATIONS: Record<string, string> = {
  "MOCK/DEMO": "This trial used Howa's mock demo adapter — useful for setup checks, not a real agent result",
  HISTORICAL_SCHEMA: "This trial was recorded before current honesty metadata existed — interpret it cautiously",
  NO_BEHAVIORAL_EVIDENCE: "No behavioral evidence was collected — Howa cannot score real agent behavior",
  ALL_FAILED: "Every behavioral check failed — the agent did not demonstrate useful task behavior",
  PROVISIONAL: "Score based on partial data — some checks were skipped",
  COST_WITHHELD:
    "This agent scored zero on behavior, so its low cost was excluded — cheap failure is still failure",
  MODEL_UNKNOWN:
    "The agent didn't declare which model it used — cost comparison is impossible",
  COST_UNKNOWN:
    "The agent didn't report cost truthfully — best-value comparisons are unavailable",
  ERROR_NOT_COUNTED:
    "The adapter or setup failed before useful behavior was measured — this is not counted as an agent behavior score",
};

const program = new Command();
program
  // `howa` is preserved as the CLI binary name for v0.1 install
  // compatibility (matches `bin` in package.json and existing PATH wiring).
  // The product brand is Howa; downstream installs can alias `howa` to the
  // same binary.
  .name("howa")
  .description("Howa — Agent Proving Ground")
  .version("0.1.0");

program
  .command("init")
  .description("Create howa.config.json by probing local agent binaries")
  .action(async () => {
    const stateRootInput = await askStateRoot();
    const stateRoot = expandHome(stateRootInput || INIT_STATE_ROOT_PROMPT_DEFAULT);
    const resolvedStateRoot = path.resolve(stateRoot);
    const configPath = path.resolve(process.cwd(), "howa.config.json");
    const discovered = await discoverAgentBinaries();

    const config = {
      schemaVersion: 1,
      stateRoot: resolvedStateRoot,
      agents: Object.fromEntries(
        discovered.map((agent) => [
          agent.name,
          {
            adapter: agent.adapter,
            binary: agent.path,
            ...(agent.env ? { env: agent.env } : {}),
          },
        ]),
      ),
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(resolvedStateRoot, { recursive: true });
    await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);

    process.stdout.write(`Wrote ${configPath}\n`);
    if (discovered.length === 0) {
      process.stdout.write(`No common agent binaries found on PATH.\n`);
    } else {
      process.stdout.write(`Discovered agents:\n`);
      for (const agent of discovered) {
        process.stdout.write(`  ${agent.name.padEnd(12)} ${agent.path}\n`);
      }
    }

    process.stdout.write(`Running first mock trial to verify setup...\n`);
    const summary = await runTrial({
      adapter: getAdapter("mock"),
      packs: [getPack("stamina")],
      stateRoot: resolvedStateRoot,
      cleanupPolicy: "success",
      baseRunOptions: { location: "local" },
    });
    process.stdout.write(
      `Mock trial ${summary.trialId} — ${summary.verdict.toUpperCase()} ` +
        `(pass=${summary.passCount}, fail=${summary.failCount})\n`,
    );
    process.stdout.write(`state=${resolvedStateRoot}\n`);
    if (summary.verdict === "fail" || summary.verdict === "error") {
      process.exitCode = 2;
    }
  });

program
  .command("list")
  .argument("<what>", "agents | packs")
  .description("List available adapters or test packs")
  .action(async (what: string) => {
    if (what === "agents") {
      for (const a of listAdapters()) {
        process.stdout.write(`${a.id.padEnd(14)} ${a.name} — ${a.description}\n`);
      }
    } else if (what === "packs") {
      for (const p of listPacks()) {
        process.stdout.write(
          `${p.id.padEnd(14)} ${p.title} (${p.tests.length} tests)\n  ${p.description}\n`,
        );
      }
    } else {
      console.error(`Unknown subject "${what}". Try: agents | packs`);
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Run a trial")
  .requiredOption("--agent <id>", "Adapter id (mock, aedis, openclaw, hermes, generic-cli)")
  .option(
    "--pack <ids...>",
    "One or more pack ids (truthfulness, repo-editing, safety, stamina, local-model). Default: all.",
  )
  .option("--model <name>", "Model name to pass to the adapter (operator-supplied identity)")
  .option(
    "--provider <name>",
    "Provider name (e.g. anthropic, openai, ollama). Operator-supplied; promotes modelIdentity to 'declared'.",
  )
  .option(
    "--cost-mode <mode>",
    "Cost truth claim: reported | estimated | free | unknown. Operator-supplied; lets unknown-cost adapters be marked truthfully without changing adapter code.",
  )
  .option(
    "--cost-source <text>",
    "Free-form note about where the cost number comes from. Stored on costInfo.note when --cost-mode is set.",
  )
  .option("--location <loc>", "local | cloud | unknown")
  .option("--state <dir>", "Override state root", defaultStateRoot())
  .option(
    "--cleanup <policy>",
    "Workspace cleanup policy: always | success (default) | never",
    "success",
  )
  .option("--quiet", "Suppress per-event output")
  .option("--watch", "Print live trial events as they happen")
  .option("--live", "Alias for --watch")
  .option("--explain", "Print plain-English explanations for honesty stamps")
  .option("--skip <ids...>", "Test IDs to skip (e.g. stamina.long-prompt)")
  .option("--only <ids...>", "Only run these test IDs")
  .action(async (raw) => {
    const opts = raw as {
      agent: string;
      pack?: string[];
      model?: string;
      provider?: string;
      costMode?: "reported" | "estimated" | "free" | "unknown";
      costSource?: string;
      location?: "local" | "cloud" | "unknown";
      state: string;
      cleanup: "always" | "success" | "never";
      quiet?: boolean;
      watch?: boolean;
      live?: boolean;
      explain?: boolean;
      skip?: string[];
      only?: string[];
    };
    if (
      opts.costMode &&
      !["reported", "estimated", "free", "unknown"].includes(opts.costMode)
    ) {
      console.error(
        `--cost-mode must be one of: reported | estimated | free | unknown (got "${opts.costMode}")`,
      );
      process.exit(1);
    }
    if (!["always", "success", "never"].includes(opts.cleanup)) {
      console.error(
        `--cleanup must be one of: always | success | never (got "${opts.cleanup}")`,
      );
      process.exit(1);
    }
    const adapter = getAdapter(opts.agent);
    const packs = (opts.pack && opts.pack.length ? opts.pack : listPacks().map((p) => p.id)).map(
      getPack,
    );

    // Filter tests by --skip / --only
    if (opts.skip?.length || opts.only?.length) {
      const skipSet = new Set(opts.skip ?? []);
      const onlySet = opts.only ? new Set(opts.only) : null;
      for (const pack of packs) {
        pack.tests = pack.tests.filter((t) => {
          if (skipSet.has(t.id)) return false;
          if (onlySet && !onlySet.has(t.id)) return false;
          return true;
        });
      }
    }

    const summary = await runTrial({
      adapter,
      packs,
      stateRoot: opts.state,
      cleanupPolicy: opts.cleanup,
      baseRunOptions: {
        model: opts.model,
        location: opts.location,
        // Fold operator overrides into `extra` for the truth-resolver.
        // Adapter-specific keys (e.g. AEDIS_BIN's `extra.command`) are
        // not affected; this just adds the identity/cost claims.
        extra:
          opts.provider || opts.costMode || opts.costSource
            ? {
                ...(opts.provider ? { provider: opts.provider } : {}),
                ...(opts.costMode ? { costMode: opts.costMode } : {}),
                ...(opts.costSource ? { costSource: opts.costSource } : {}),
              }
            : undefined,
      },
      onEvent: (e) => {
        if (opts.quiet) return;
        const watching = opts.watch || opts.live;
        if (watching) {
          process.stdout.write(
            `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.severity.toUpperCase()} ${e.phase}` +
              `${e.testId ? ` ${e.testId}` : ""} — ${e.message}\n`,
          );
        } else if (e.phase === "test_started") {
          process.stdout.write(`▷ ${e.testId}\n`);
        } else if (e.phase === "test_passed" || e.phase === "test_failed" || e.phase === "warning") {
          const sym = e.severity === "pass" ? "✓" : e.severity === "warn" ? "!" : "✗";
          if (e.testId) process.stdout.write(`${sym} ${e.testId} — ${e.message}\n`);
        }
      },
    });
    // Setup-failure path: the runner short-circuited with one preflight
    // receipt. Surface the operator guidance loud and clearly so people
    // don't think Aedis "failed truthfulness" when the binary is missing.
    if (
      summary.verdict === "error" &&
      typeof summary.notes === "string" &&
      summary.notes.includes("setup_failed")
    ) {
      const reason = summary.notes.replace(/^.*reason="([\s\S]*?)".*$/, "$1");
      process.stdout.write(`\n┌── Adapter setup failed ──────────────────────────────────────\n`);
      process.stdout.write(`│ ${reason}\n`);
      process.stdout.write(`├── Suggested fixes:\n`);
      if (opts.agent === "aedis") {
        process.stdout.write(`│   • If you have a local Aedis checkout:\n`);
        process.stdout.write(`│       (cd /path/to/aedis && npm run build)\n`);
        process.stdout.write(`│       export AEDIS_BIN="node /path/to/aedis/dist/cli/aedis.js"\n`);
        process.stdout.write(`│   • Or point AEDIS_BIN at the absolute aedis path:\n`);
        process.stdout.write(`│       export AEDIS_BIN=/usr/local/bin/aedis\n`);
      } else if (opts.agent === "mechanic") {
        process.stdout.write(`│   • the Mechanic currently ships as a service (port 18810), not a CLI.\n`);
        process.stdout.write(`│   • Until a real the Mechanic CLI lands, point MECHANIC_BIN at a wrapper that\n`);
        process.stdout.write(`│     prints a "Commands: submit, …" usage line and forwards submit\n`);
        process.stdout.write(`│     to POST /api/tasks. See docs/ADAPTERS.md (the Mechanic wrapper recipe).\n`);
        process.stdout.write(`│   • If a CLI exists already:\n`);
        process.stdout.write(`│       export MECHANIC_BIN="node /path/to/mechanic/dist/cli.js"\n`);
      } else {
        process.stdout.write(`│   • Make sure the agent's binary is on PATH or set the\n`);
        process.stdout.write(`│     adapter's BIN env var to an absolute path.\n`);
      }
      process.stdout.write(`└──────────────────────────────────────────────────────────────\n`);
    }
    process.stdout.write(`\nTrial ${summary.trialId} — ${summary.verdict.toUpperCase()}\n`);
    process.stdout.write(
      `  pass=${summary.passCount}  fail=${summary.failCount}  total=${summary.testCount}\n`,
    );
    process.stdout.write(`  trust=${(summary.score.trust * 100).toFixed(0)}%\n`);
    process.stdout.write(`  velum=${summary.velumDecision}\n`);
    // Print honesty stamps inline so anyone reading CLI output cannot
    // miss provisional / mock / no-evidence / cost-withheld signals.
    const honesty = summary.honesty ?? summary.score.honesty;
    const stamps: string[] = [];
    if (summary.isMockTrial) stamps.push("MOCK/DEMO");
    if (summary.schemaVersion === undefined || summary.schemaVersion < 2) {
      stamps.push("HISTORICAL_SCHEMA");
    }
    if (honesty?.noBehavioralEvidence) stamps.push("NO_BEHAVIORAL_EVIDENCE");
    if (honesty?.allBehavioralFailed) stamps.push("ALL_FAILED");
    if (honesty?.provisional && !honesty.noBehavioralEvidence) stamps.push("PROVISIONAL");
    if (honesty?.costExcludedFromTrust) stamps.push("COST_WITHHELD");
    if (honesty?.modelUnknown) stamps.push("MODEL_UNKNOWN");
    if (honesty?.costUnknown) stamps.push("COST_UNKNOWN");
    if (summary.verdict === "error") stamps.push("ERROR_NOT_COUNTED");
    if (stamps.length > 0) {
      process.stdout.write(`  honesty=${stamps.join(",")}\n`);
      if (opts.explain) {
        for (const stamp of stamps) {
          const explanation = HONESTY_EXPLANATIONS[stamp];
          if (explanation) {
            process.stdout.write(`    ${stamp}: ${explanation}\n`);
          }
        }
      }
    }
    process.stdout.write(
      `  howa=v${summary.howaVersion}@${summary.gitCommit} · adapter=${summary.adapter}@v${summary.adapterVersion}\n`,
    );
    process.stdout.write(
      `  adapter-truth: model=${summary.adapterTruth.modelIdentity} cost=${summary.adapterTruth.costTruth} events=${summary.adapterTruth.eventStructure} tools=${summary.adapterTruth.toolSupport ? "yes" : "no"}\n`,
    );
    process.stdout.write(`  state=${path.resolve(opts.state)}\n`);
    if (summary.verdict === "fail" || summary.verdict === "error") {
      process.exitCode = 2;
    }
  });

program
  .command("report")
  .argument("<trialId>")
  .option("--state <dir>", "Override state root", defaultStateRoot())
  .option("--json", "Emit JSON instead of Markdown")
  .description("Print a trial report (summary + per-test receipts)")
  .action(async (trialId: string, raw) => {
    const opts = raw as { state: string; json?: boolean };
    const trials = new TrialStore(opts.state);
    const summary = await trials.getTrial(trialId);
    if (!summary) {
      console.error(`No trial ${trialId} under ${opts.state}`);
      process.exit(1);
    }
    const receipts = new ReceiptStore(opts.state);
    const list = await receipts.list(trialId);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ summary, receipts: list }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`# Trial ${summary.trialId}\n`);
    process.stdout.write(`Agent: ${summary.agentId} · Adapter: ${summary.adapter} v${summary.adapterVersion}\n`);
    process.stdout.write(`Howa: v${summary.howaVersion} · commit ${summary.gitCommit}\n`);
    process.stdout.write(
      `Adapter truth: model=${summary.adapterTruth.modelIdentity} · cost=${summary.adapterTruth.costTruth} · events=${summary.adapterTruth.eventStructure} · tools=${summary.adapterTruth.toolSupport ? "yes" : "no"}\n`,
    );
    process.stdout.write(
      `Pack versions: ${Object.entries(summary.packVersions).map(([k, v]) => `${k}@${v}`).join(", ")}\n`,
    );
    process.stdout.write(`Verdict: **${summary.verdict.toUpperCase()}**\n`);
    process.stdout.write(`Trust: ${(summary.score.trust * 100).toFixed(0)}%\n`);
    process.stdout.write(`Pass: ${summary.passCount}/${summary.testCount} (fail: ${summary.failCount})\n`);
    process.stdout.write(`Velum: ${summary.velumDecision}\n`);
    const reportHonesty = summary.honesty ?? summary.score.honesty;
    const reportStamps: string[] = [];
    if (summary.isMockTrial) reportStamps.push("MOCK/DEMO");
    if (summary.schemaVersion === undefined || summary.schemaVersion < 2) {
      reportStamps.push("HISTORICAL_SCHEMA");
    }
    if (reportHonesty?.noBehavioralEvidence) reportStamps.push("NO_BEHAVIORAL_EVIDENCE");
    if (reportHonesty?.allBehavioralFailed) reportStamps.push("ALL_FAILED");
    if (reportHonesty?.provisional && !reportHonesty.noBehavioralEvidence) reportStamps.push("PROVISIONAL");
    if (reportHonesty?.costExcludedFromTrust) reportStamps.push("COST_WITHHELD");
    if (reportHonesty?.modelUnknown) reportStamps.push("MODEL_UNKNOWN");
    if (reportHonesty?.costUnknown) reportStamps.push("COST_UNKNOWN");
    if (summary.verdict === "error") reportStamps.push("ERROR_NOT_COUNTED");
    if (reportStamps.length > 0) {
      process.stdout.write(`Honesty: ${reportStamps.join(", ")}\n`);
    }
    process.stdout.write(`\n## Reasons\n`);
    for (const r of summary.score.reasons) process.stdout.write(`- ${r}\n`);
    process.stdout.write(`\n## Receipts\n`);
    for (const r of list) {
      process.stdout.write(`\n${renderReceipt(r)}\n`);
    }
  });

program
  .command("compare")
  .argument("<baseTrialId>")
  .argument("<candidateTrialId>")
  .option("--state <dir>", "Override state root", defaultStateRoot())
  .description("Compare two trials by category score and per-test verdict")
  .action(async (baseTrialId: string, candidateTrialId: string, raw) => {
    const opts = raw as { state: string };
    try {
      const comparison = await compareTrials(opts.state, baseTrialId, candidateTrialId);
      const { base, candidate, categoryDiffs, testDiffs, regressions } = comparison;
      process.stdout.write(`Trial comparison\n`);
      process.stdout.write(`  base=${base.trialId} (${base.verdict.toUpperCase()}, trust=${formatPct(base.score.trust)})\n`);
      process.stdout.write(
        `  candidate=${candidate.trialId} (${candidate.verdict.toUpperCase()}, trust=${formatPct(candidate.score.trust)})\n`,
      );
      process.stdout.write(`  regressions=${regressions.length}\n`);

      process.stdout.write(`\nCategory diffs\n`);
      for (const d of categoryDiffs) {
        process.stdout.write(
          `  ${String(d.category).padEnd(16)} ${formatScore(d.baseValue).padStart(6)} → ${formatScore(d.candidateValue).padEnd(6)} ${formatDelta(d.delta)} (n ${d.baseN}→${d.candidateN})\n`,
        );
      }

      const changed = testDiffs.filter((d) => d.changed);
      process.stdout.write(`\nTest verdict diffs\n`);
      if (changed.length === 0) {
        process.stdout.write(`  No verdict changes.\n`);
      } else {
        for (const d of changed) {
          process.stdout.write(
            `  ${d.testId.padEnd(32)} ${formatVerdict(d.baseVerdict)} → ${formatVerdict(d.candidateVerdict)}\n`,
          );
        }
      }

      process.stdout.write(`\nRegressions\n`);
      if (regressions.length === 0) {
        process.stdout.write(`  None.\n`);
      } else {
        for (const r of regressions) {
          process.stdout.write(
            `  ${r.testId.padEnd(32)} PASS → ${String(r.candidateVerdict).toUpperCase()}\n`,
          );
        }
      }
      process.stdout.write(`  state=${path.resolve(opts.state)}\n`);
    } catch (err) {
      if (err instanceof TrialNotFoundError) {
        console.error(`No ${err.role} trial ${err.trialId} under ${opts.state}`);
        process.exit(1);
        return;
      }
      throw err;
    }
  });

program
  .command("daily-driver")
  .argument("<action>", "list | run | verify")
  .option("--candidate <file>", "Secret-free candidate JSON (required for run)")
  .option("--output <dir>", "Application-write-once receipt/export root", "howa-daily-driver")
  .option("--run-id <id>", "Stable run/campaign identity")
  .option("--trial <ids...>", "Run only the named V1 trial ids")
  .option("--keep-fixtures", "Preserve temporary synthetic fixtures for debugging")
  .option("--receipt <file>", "Receipt to verify")
  .option("--evidence-root <dir>", "Root containing the receipt evidence directory")
  .description("List or run the Hermes Daily Driver V1 proving suite")
  .action(async (action: string, raw) => {
    const opts = raw as { candidate?: string; output: string; runId?: string; trial?: string[]; keepFixtures?: boolean; receipt?: string; evidenceRoot?: string };
    if (action === "list") {
      for (const trial of HERMES_DAILY_DRIVER_V1.trials) {
        process.stdout.write(`${trial.id}\t${trial.title}\t${trial.timeout_ms}ms\n`);
      }
      return;
    }
    if(action==="verify"){
      if(!opts.receipt||!opts.evidenceRoot) throw new Error("Usage: howa daily-driver verify --receipt <receipt.json> --evidence-root <dir>");
      const receipt=JSON.parse(await fs.readFile(path.resolve(opts.receipt),"utf8")) as DailyDriverReceiptV1; validateReceipt(receipt); await verifyReceiptEvidence(receipt,path.resolve(opts.evidenceRoot),true); process.stdout.write(`VERIFIED\t${receipt.receipt_digest}\n`); return;
    }
    if (action !== "run" || !opts.candidate || !opts.runId) {
      throw new Error("Usage: howa daily-driver run --candidate <candidate.json> --run-id <id> [--output <dir>] [--trial <ids...>]");
    }
    const candidatePath = path.resolve(opts.candidate);
    const candidate = JSON.parse(await fs.readFile(candidatePath, "utf8")) as DailyDriverCandidate;
    const results = await runDailyDriverSuite({ candidate, output_root: path.resolve(opts.output), run_id: opts.runId, trial_ids: opts.trial, keep_fixtures: opts.keepFixtures });
    for (const result of results) {
      process.stdout.write(`${result.receipt.trial_id}\t${result.receipt.raw_verdict}\t${result.receipt.receipt_digest}\t${result.receipt_path}\n`);
    }
    if (results.some((result) => !result.receipt.accepted)) process.exitCode = 2;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function formatDelta(value: number | null): string {
  if (value === null) return "(n/a)";
  return `(${value >= 0 ? "+" : ""}${value.toFixed(2)})`;
}

function formatVerdict(value: string | null): string {
  return value === null ? "MISSING" : value.toUpperCase();
}

async function askStateRoot(): Promise<string> {
  if (!process.stdin.isTTY) return INIT_STATE_ROOT_PROMPT_DEFAULT;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`State root [${INIT_STATE_ROOT_PROMPT_DEFAULT}]: `);
    return answer.trim() || INIT_STATE_ROOT_PROMPT_DEFAULT;
  } finally {
    rl.close();
  }
}

function expandHome(value: string): string {
  const home = process.env.HOME?.trim() || os.homedir();
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

async function discoverAgentBinaries(): Promise<
  Array<{ name: string; adapter: string; path: string; env?: string }>
> {
  const seen = new Set<string>();
  const found: Array<{ name: string; adapter: string; path: string; env?: string }> = [];
  for (const candidate of COMMON_AGENT_BINARIES) {
    const resolved = findOnPath(candidate.binary);
    if (!resolved) continue;
    const key = `${candidate.adapter}:${candidate.binary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      name: candidate.binary,
      adapter: candidate.adapter,
      path: resolved,
      env: candidate.env,
    });
  }
  return found;
}

function findOnPath(binary: string): string | null {
  const result = spawnSync(process.platform === "win32" ? "where" : "command", [
    process.platform === "win32" ? binary : "-v",
    ...(process.platform === "win32" ? [] : [binary]),
  ], {
    encoding: "utf8",
    shell: process.platform !== "win32",
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}
