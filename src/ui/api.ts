/* Tiny typed API client used by every page. */

export interface AdapterTruthContract {
  modelIdentity: "declared" | "inferred" | "unknown";
  costTruth: "reported" | "estimated" | "unknown";
  eventStructure: "structured" | "unstructured";
  toolSupport: boolean;
}

export interface AdapterProtocol {
  name: string;
  submitCommand?: string;
  notes?: string[];
}

export type CapabilityState =
  | "PROVEN"
  | "SUPPORTED_NOT_PROVEN"
  | "UNSUPPORTED"
  | "BLOCKED_BY_CONFIG"
  | "NOT_TESTED"
  | "UNKNOWN";

export interface CapabilityStatus {
  key: string;
  label: string;
  state: CapabilityState;
  claimed: boolean | null;
  evidence: {
    source: "static" | "probe" | "trial" | "receipt" | "unknown";
    lastTestedAt?: number;
    evidencePath?: string;
    receiptId?: string;
    trialId?: string;
    reason: string;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  version?: string;
  /** Static adapter claims. Not proof. */
  capabilities: Record<string, boolean>;
  capabilityMatrix?: Record<string, CapabilityStatus>;
  capabilityList?: CapabilityStatus[];
  truth?: AdapterTruthContract;
  protocol?: AdapterProtocol;
}

export interface PackTest {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: string;
}

export interface PackSummary {
  id: string;
  title: string;
  description: string;
  tests: PackTest[];
}

export interface ScoreHonesty {
  provisional: boolean;
  noBehavioralEvidence: boolean;
  allBehavioralFailed: boolean;
  costExcludedFromTrust: boolean;
  noBehavioralCategories: boolean;
  behavioralN: number;
  provisionalThreshold: number;
  /** Phase-3 release-hardening fields. */
  modelUnknown?: boolean;
  costUnknown?: boolean;
  noOpExpectedPassCount?: number;
}

export interface TrialScore {
  passRate: number;
  trust: number;
  perCategory: Array<{ category: string; value: number; n: number; reasons: string[] }>;
  costEfficiency: { value: number; n: number; reasons: string[] };
  reasons: string[];
  /** Optional on older trials saved before honesty was tracked. */
  honesty?: ScoreHonesty;
}

export interface TrialSummary {
  trialId: string;
  agentId: string;
  adapter: string;
  packs: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  verdict: "pass" | "fail" | "warn" | "skipped" | "error";
  score: TrialScore;
  testCount: number;
  passCount: number;
  failCount: number;
  velumDecision: "allow" | "warn" | "block" | "fail-test";
  notes?: string;
  liveMode?: "live" | "buffered" | "replay";
  eventCount?: number;
  /** Trust honesty stamps — present on v0.1.1+ trials. */
  isMockTrial?: boolean;
  honesty?: ScoreHonesty;
  schemaVersion?: number;
}

export interface TrialEvent {
  sequence: number;
  trialId: string;
  packId?: string;
  testId?: string;
  timestamp: number;
  phase:
    | "queued"
    | "starting"
    | "adapter_event"
    | "test_started"
    | "test_passed"
    | "test_failed"
    | "warning"
    | "guard_blocked"
    | "scoring"
    | "receipt_written"
    | "complete";
  severity: "info" | "pass" | "warn" | "fail" | "critical";
  message: string;
  evidence?: {
    receiptId?: string;
    receiptPath?: string;
    artifactPath?: string;
    detail?: string;
  };
  adapter?: {
    id: string;
    version?: string;
  };
  model?: { model: string; provider: string; location: string; adapterVersion?: string };
  source: "runner" | "adapter" | "velum" | "scoring" | "receipt";
  mode?: "live" | "buffered" | "replay";
  rawKind?: string;
}

export interface Receipt {
  receiptId: string;
  trialId: string;
  testId: string;
  agentId: string;
  adapter: string;
  modelInfo: { model: string; provider: string; location: string };
  costInfo: {
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    reported: boolean;
    note?: string;
  };
  prompt: string;
  expectedBehavior: string;
  observedBehavior: string;
  verdict: "pass" | "fail" | "warn" | "skipped" | "error" | string;
  failureType?:
    | "no_output"
    | "wrong_output"
    | "silent_success"
    | "unsafe_action"
    | "scope_violation"
    | "tool_failure_hidden"
    | "incomplete_execution"
    | "timeout"
    | "adapter_setup_failed"
    | "infrastructure_failure"
    | "clarification_required"
    | "no_evidence";
  evaluationCategory?:
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
    | "STAMINA_LONG_PROMPT_FAILED";
  reasons: string[];
  artifacts: { path: string; bytes: number; preview?: string }[];
  stdoutSummary: string;
  stderrSummary: string;
  velum: {
    decision: string;
    agentDecision?: string;
    findings: {
      rule: string;
      severity: string;
      decision: string;
      snippet: string;
      reason: string;
      source?: string;
    }[];
    safeText: string;
  };
  events: { ts: number; kind: string; text?: string }[];
  streamMode?: "live" | "buffered" | "replay";
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => j<{ agents: AgentSummary[] }>("/api/agents").then((r) => r.agents),
  packs: () => j<{ packs: PackSummary[] }>("/api/packs").then((r) => r.packs),
  trials: () => j<{ trials: TrialSummary[] }>("/api/trials").then((r) => r.trials),
  trial: (id: string) => j<TrialSummary>(`/api/trials/${id}`),
  startTrial: (body: {
    agent: string;
    packs: string[];
    model?: string;
    location?: "local" | "cloud" | "unknown";
  }) =>
    j<{ trialId: string }>("/api/trials", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  receipts: (trialId: string) =>
    j<{ receipts: Receipt[] }>(`/api/receipts/${trialId}`).then((r) => r.receipts),
  receipt: (trialId: string, testId: string) =>
    j<Receipt>(`/api/receipts/${trialId}/${encodeURIComponent(testId)}`),
};

export function streamTrialEvents(
  trialId: string,
  onEvent: (e: TrialEvent) => void,
): () => void {
  const es = new EventSource(`/api/trials/${trialId}/events`);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  };
  es.addEventListener("end", () => es.close());
  es.onerror = () => es.close();
  return () => es.close();
}
