import type { Receipt, TrialSummary } from "./api.js";
import { failureTypeLabel, formatCostStatus, formatModelStatus } from "./trust-display.js";

const MAX_BLOCK = 1_600;

export function buildAgentFixReport(trial: TrialSummary, receipts: Receipt[]): string {
  const actionItems = receipts.filter((r) =>
    ["fail", "warn", "error"].includes(String(r.verdict)),
  );
  const lines: string[] = [];
  lines.push(`# Howa Trial Fix Report`);
  lines.push("");
  lines.push(`Trial: ${trial.trialId}`);
  lines.push(`Agent: ${trial.agentId}`);
  lines.push(`Verdict: ${trial.verdict.toUpperCase()}`);
  lines.push(`Trust: ${Math.round(trial.score.trust * 100)}%`);
  lines.push(`Pass: ${trial.passCount}/${trial.testCount}`);
  lines.push(`Velum: ${trial.velumDecision}`);
  lines.push(`Timeline mode: ${trial.liveMode ?? receipts[0]?.streamMode ?? "buffered"}`);

  // Honesty stamps. Without this section, a downstream agent reading the
  // markdown could quote "trust 66%" without knowing the trial used the
  // mock adapter, had no behavioral evidence, or was below the
  // small-sample threshold. Surfacing the flags here is the export side
  // of the trust-honesty fix the pre-release audit demanded.
  const h = trial.honesty ?? trial.score.honesty;
  const honestyStamps: string[] = [];
  if (trial.isMockTrial) {
    honestyStamps.push("MOCK / DEMO — bundled mock adapter; not evidence about a real agent");
  }
  if (h?.noBehavioralEvidence) {
    honestyStamps.push(
      "NO BEHAVIORAL EVIDENCE — every behavioral category averaged zero or had no countable results",
    );
  }
  if (h?.allBehavioralFailed) {
    honestyStamps.push("ALL BEHAVIORAL FAILED — no test passed");
  }
  if (h?.provisional && !h.noBehavioralEvidence) {
    honestyStamps.push(
      `PROVISIONAL · SMALL SAMPLE — only ${h.behavioralN} behavioral test(s); under ${h.provisionalThreshold}-test threshold for an authoritative trust claim`,
    );
  }
  if (h?.costExcludedFromTrust) {
    honestyStamps.push(
      "COST WITHHELD FROM TRUST — cost-efficiency reported but excluded because behavioral correctness was zero",
    );
  }
  if (h?.modelUnknown) {
    honestyStamps.push(
      "MODEL UNKNOWN — neither adapter nor operator declared model/provider (use --model and --provider to attribute)",
    );
  }
  if (h?.costUnknown) {
    honestyStamps.push(
      "COST UNKNOWN — adapter cannot introspect cost; excluded from any 'best value' ranking",
    );
  }
  // Historical-schema marking — trials saved before the release-hardening
  // pass have schemaVersion < 2 (or undefined). They predate honesty
  // metadata and are excluded from current rankings by default.
  if (trial.schemaVersion === undefined || trial.schemaVersion < 2) {
    honestyStamps.push(
      "HISTORICAL SCHEMA — predates honesty metadata; excluded from current rankings unless explicitly opted in",
    );
  }
  if (trial.verdict === "error") {
    honestyStamps.push("ERROR · NOT COUNTED — trial errored before completing; exclude from leaderboards");
  }
  if (honestyStamps.length > 0) {
    lines.push("");
    lines.push("Honesty stamps:");
    for (const s of honestyStamps) lines.push(`- ${s}`);
  }

  lines.push("");
  lines.push(`## What To Fix`);
  lines.push("");
  if (actionItems.length === 0) {
    lines.push("No failing or warning receipts were recorded.");
  } else {
    for (const r of actionItems) {
      lines.push(`### ${r.testId} — ${String(r.verdict).toUpperCase()}${r.failureType ? ` (${failureTypeLabel(r.failureType)})` : ""}`);
      if (r.failureType) {
        lines.push(`Failure type: ${r.failureType}`);
      }
      if (r.evaluationCategory) {
        lines.push(`Evaluation category: ${r.evaluationCategory}`);
      }
      const model = formatModelStatus(r.modelInfo);
      const cost = formatCostStatus(r.costInfo);
      lines.push(`Model/provider/location: ${model.primary} · ${model.detail}`);
      lines.push(`Cost: ${cost.primary} · ${cost.detail}`);
      lines.push("");
      lines.push(`Expected: ${oneLine(r.expectedBehavior)}`);
      if (r.reasons.length) {
        lines.push("");
        lines.push("Reasons:");
        for (const reason of r.reasons.slice(0, 5)) lines.push(`- ${reason}`);
      }
      if (r.observedBehavior.trim()) {
        lines.push("");
        lines.push("Observed evidence:");
        lines.push(fence(limit(r.observedBehavior)));
      }
      if (r.stderrSummary.trim()) {
        lines.push("");
        lines.push("stderr:");
        lines.push(fence(limit(r.stderrSummary)));
      }
      if (r.stdoutSummary.trim()) {
        lines.push("");
        lines.push("stdout:");
        lines.push(fence(limit(r.stdoutSummary)));
      }
      const events = (r.events ?? [])
        .filter((e) => e.text)
        .slice(-8)
        .map((e) => `${new Date(e.ts).toISOString()} ${e.kind}: ${e.text}`);
      if (events.length) {
        lines.push("");
        lines.push("Recent events:");
        lines.push(fence(limit(events.join("\n"))));
      }
      lines.push("");
      lines.push(`Receipt path: howa-state/receipts/${trial.trialId}/${safeReceiptName(r.testId)}.json`);
      lines.push("");
    }
  }
  lines.push("## Score Breakdown");
  lines.push("");
  for (const c of trial.score.perCategory.filter((c) => c.n > 0)) {
    lines.push(`- ${c.category}: ${Math.round(c.value * 100)}% — ${c.reasons[0] ?? ""}`);
  }
  lines.push(`- costEfficiency: ${Math.round(trial.score.costEfficiency.value * 100)}% — ${trial.score.costEfficiency.reasons[0] ?? ""}`);
  lines.push("");
  lines.push("## Instructions For The Fixing Agent");
  lines.push("");
  lines.push("- Fix the underlying agent behavior or adapter configuration, not Howa scoring.");
  lines.push("- Treat setup/auth errors as environment issues unless the adapter contract is wrong.");
  lines.push("- Preserve existing passing behavior.");
  lines.push("- Re-run the same Howa packs after changes and compare receipts.");
  return lines.join("\n");
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  document.body.removeChild(el);
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function limit(text: string): string {
  return text.length <= MAX_BLOCK ? text : `${text.slice(0, MAX_BLOCK)}\n...[truncated]`;
}

function fence(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

function safeReceiptName(testId: string): string {
  return testId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
