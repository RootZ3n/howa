import type { AgentAdapter } from "./adapters/types.js";
import type { Receipt } from "./receipts/receipt.js";
import type { TrialSummary } from "./storage/index.js";
import type { Capabilities } from "./types.js";

export const CANONICAL_CAPABILITIES = [
  "streaming",
  "toolUse",
  "fileEditing",
  "shellExecution",
  "modelSelection",
  "reportsCost",
  "reportsTokens",
] as const;

export type CapabilityKey = (typeof CANONICAL_CAPABILITIES)[number];

export type CapabilityState =
  | "PROVEN"
  | "SUPPORTED_NOT_PROVEN"
  | "UNSUPPORTED"
  | "BLOCKED_BY_CONFIG"
  | "NOT_TESTED"
  | "UNKNOWN";

export type CapabilityEvidenceSource =
  | "static"
  | "probe"
  | "trial"
  | "receipt"
  | "unknown";

export interface CapabilityEvidence {
  source: CapabilityEvidenceSource;
  lastTestedAt?: number;
  evidencePath?: string;
  receiptId?: string;
  trialId?: string;
  reason: string;
}

export interface CapabilityStatus {
  key: CapabilityKey;
  label: string;
  state: CapabilityState;
  claimed: boolean | null;
  evidence: CapabilityEvidence;
}

export type CapabilityMatrix = Record<CapabilityKey, CapabilityStatus>;

export interface CapabilityEvidenceInput {
  trials?: TrialSummary[];
  receiptsByTrialId?: Record<string, Receipt[]>;
}

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  streaming: "Streaming",
  toolUse: "Tool Use",
  fileEditing: "File Editing",
  shellExecution: "Shell Execution",
  modelSelection: "Model Selection",
  reportsCost: "Reports Cost",
  reportsTokens: "Reports Tokens",
};

export function buildCapabilityMatrix(
  adapter: AgentAdapter,
  evidenceInput: CapabilityEvidenceInput = {},
): CapabilityMatrix {
  const matrix = Object.fromEntries(
    CANONICAL_CAPABILITIES.map((key) => [key, staticCapabilityStatus(adapter.capabilities, key)]),
  ) as CapabilityMatrix;

  const trials = (evidenceInput.trials ?? [])
    .filter((trial) => trial.agentId === adapter.id || trial.adapter === adapter.id)
    .sort((a, b) => b.finishedAt - a.finishedAt);

  applyConfigBlockEvidence(matrix, adapter, trials);

  for (const trial of trials) {
    const receipts = evidenceInput.receiptsByTrialId?.[trial.trialId] ?? [];
    applyTrialEvidence(matrix, trial);
    for (const receipt of receipts) {
      applyReceiptEvidence(matrix, receipt);
    }
  }

  return matrix;
}

export function capabilityList(matrix: CapabilityMatrix): CapabilityStatus[] {
  return CANONICAL_CAPABILITIES.map((key) => matrix[key]);
}

function staticCapabilityStatus(
  capabilities: Partial<Capabilities>,
  key: CapabilityKey,
): CapabilityStatus {
  const claimed = typeof capabilities[key] === "boolean" ? capabilities[key] : null;
  if (claimed === true) {
    return {
      key,
      label: CAPABILITY_LABELS[key],
      state: "SUPPORTED_NOT_PROVEN",
      claimed,
      evidence: {
        source: "static",
        reason: "Adapter declares support, but no runtime proof has been recorded yet.",
      },
    };
  }
  if (claimed === false) {
    return {
      key,
      label: CAPABILITY_LABELS[key],
      state: "UNSUPPORTED",
      claimed,
      evidence: {
        source: "static",
        reason: "Adapter declares this capability unsupported.",
      },
    };
  }
  return {
    key,
    label: CAPABILITY_LABELS[key],
    state: "UNKNOWN",
    claimed,
    evidence: {
      source: "unknown",
      reason: "Adapter did not declare this canonical capability.",
    },
  };
}

function applyConfigBlockEvidence(
  matrix: CapabilityMatrix,
  adapter: AgentAdapter,
  trials: TrialSummary[],
) {
  const latestBlocked = trials.find((trial) => {
    const notes = trial.notes ?? "";
    return (
      trial.testCount === 0 &&
      (trial.verdict === "error" || /setup_failed|preflight/i.test(notes))
    );
  });
  if (!latestBlocked) return;

  for (const key of CANONICAL_CAPABILITIES) {
    if (adapter.capabilities[key] !== true) continue;
    if (matrix[key].state === "PROVEN") continue;
    matrix[key] = {
      ...matrix[key],
      state: "BLOCKED_BY_CONFIG",
      evidence: {
        source: "trial",
        lastTestedAt: latestBlocked.finishedAt,
        trialId: latestBlocked.trialId,
        reason:
          latestBlocked.notes ??
          "Latest trial could not run because adapter setup or configuration failed.",
      },
    };
  }
}

function applyTrialEvidence(matrix: CapabilityMatrix, trial: TrialSummary) {
  if (trial.liveMode === "live") {
    prove(matrix, "streaming", {
      source: "trial",
      lastTestedAt: trial.finishedAt,
      trialId: trial.trialId,
      reason: "Trial ran with live event mode.",
    });
  }
}

function applyReceiptEvidence(matrix: CapabilityMatrix, receipt: Receipt) {
  const testedAt = receipt.finishedAt || receipt.startedAt;
  if (receipt.streamMode === "live") {
    prove(matrix, "streaming", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt was produced with live stream mode.",
    });
  }

  if (receipt.events.some((event) => event.kind === "tool_call" || event.kind === "tool_result")) {
    prove(matrix, "toolUse", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt includes structured tool events.",
    });
  }

  if (
    receipt.repoDiffStatus === "changed" ||
    receipt.artifacts.length > 0 ||
    /write_file|edited|wrote/i.test(receipt.stdoutSummary)
  ) {
    prove(matrix, "fileEditing", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt includes changed files, artifacts, or file-write output.",
    });
  }

  if (receipt.events.some((event) => /shell|command|exec/i.test(event.kind))) {
    prove(matrix, "shellExecution", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt includes shell/command execution events.",
    });
  }

  if (receipt.costInfo.reported && typeof receipt.costInfo.estimatedCostUsd === "number") {
    prove(matrix, "reportsCost", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt includes reported cost.",
    });
  }

  if (
    receipt.costInfo.reported &&
    (typeof receipt.costInfo.totalTokens === "number" ||
      typeof receipt.costInfo.promptTokens === "number" ||
      typeof receipt.costInfo.outputTokens === "number")
  ) {
    prove(matrix, "reportsTokens", {
      source: "receipt",
      lastTestedAt: testedAt,
      receiptId: receipt.receiptId,
      trialId: receipt.trialId,
      reason: "Receipt includes reported token counts.",
    });
  }
}

function prove(
  matrix: CapabilityMatrix,
  key: CapabilityKey,
  evidence: CapabilityEvidence,
) {
  const current = matrix[key];
  if (current.state === "UNSUPPORTED" || current.state === "UNKNOWN") return;
  if (
    current.state === "PROVEN" &&
    (current.evidence.lastTestedAt ?? 0) >= (evidence.lastTestedAt ?? 0)
  ) {
    return;
  }
  matrix[key] = {
    ...current,
    state: "PROVEN",
    evidence,
  };
}
