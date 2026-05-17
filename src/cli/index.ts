#!/usr/bin/env node
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listAdapters, getAdapter } from "../adapters/registry.js";
import { listPacks, getPack } from "../packs/registry.js";
import { runTrial } from "../runner/trial-runner.js";
import { defaultStateRoot, TrialStore } from "../storage/index.js";
import { ReceiptStore } from "../receipts/receipt-store.js";
import { renderReceipt } from "../receipts/receipt.js";

const program = new Command();
program
  .name("colosseum")
  .description("Colosseum — Agent Proving Ground")
  .version("0.1.0");

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
      } else if (opts.agent === "ptah") {
        process.stdout.write(`│   • Ptah currently ships as a service (port 18810), not a CLI.\n`);
        process.stdout.write(`│   • Until a real Ptah CLI lands, point PTAH_BIN at a wrapper that\n`);
        process.stdout.write(`│     prints a "Commands: submit, …" usage line and forwards submit\n`);
        process.stdout.write(`│     to POST /api/tasks. See docs/ADAPTERS.md (Ptah wrapper recipe).\n`);
        process.stdout.write(`│   • If a CLI exists already:\n`);
        process.stdout.write(`│       export PTAH_BIN="node /path/to/ptah/dist/cli.js"\n`);
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
    }
    process.stdout.write(
      `  colosseum=v${summary.colosseumVersion}@${summary.gitCommit} · adapter=${summary.adapter}@v${summary.adapterVersion}\n`,
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
    process.stdout.write(`Colosseum: v${summary.colosseumVersion} · commit ${summary.gitCommit}\n`);
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
