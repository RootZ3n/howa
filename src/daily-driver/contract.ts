import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { validateCommittedReceiptSchema } from "./json-schema.js";
import { DAILY_DRIVER_RATE_CARD_VERSION } from "./rate-card.js";

export const DAILY_DRIVER_SCHEMA_VERSION = "howa.hermes-daily-driver.receipt.v3" as const;
export const DAILY_DRIVER_SUITE_VERSION = "hermes-daily-driver.v1.1" as const;

export type RawVerdict = "PASS" | "FAIL" | "SAFE_FAIL" | "INCOMPLETE" | "ERROR";
export type AttemptOutcome = "accepted_output" | "model_failure" | "transport_failure" | "timeout";

export interface AttemptRecord {
  attempt: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  outcome: AttemptOutcome;
  error_kind: string | null;
  retryable: boolean;
  stdout_digest: string;
  stderr_digest: string;
  timeout_stage: "none" | "term_sent" | "kill_sent" | "drain_bounded";
  signals_sent: Array<"SIGTERM" | "SIGKILL">;
  cleanup_outcome: "not_required" | "group_terminated" | "group_killed" | "cleanup_unconfirmed";
}

export interface ConnectionFailure {
  attempt: number;
  kind: string;
  timestamp: string;
  message: string;
}

export interface TimeoutEvent {
  attempt: number;
  timestamp: string;
  timeout_ms: number;
  phase: "candidate_process" | "validator";
  stage: "term_sent" | "kill_sent" | "drain_bounded";
  signals_sent: Array<"SIGTERM" | "SIGKILL">;
  cleanup_outcome: "group_terminated" | "group_killed" | "cleanup_unconfirmed";
}

export interface RedactionEvent { source: string; kind: string; classification: "confirmed_secret" | "possible_sensitive"; match_digest: string; }

export interface CompactionEvent {
  attempt: number;
  timestamp: string;
  before_tokens: number | null;
  after_tokens: number | null;
}

export interface ToolCallRecord {
  attempt: number;
  sequence: number;
  name: string;
  arguments_digest: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  timed_out: boolean;
}

export interface MutationObservation {
  path: string;
  kind: "created" | "modified" | "deleted";
  allowed: boolean;
  before_digest: string | null;
  after_digest: string | null;
}

export interface DeterministicCheck {
  id: string;
  passed: boolean;
  details: string;
  evidence_refs: string[];
}

export interface EvidenceReference {
  id: string;
  kind: "stdout" | "stderr" | "artifact" | "fixture" | "validator";
  path: string;
  digest: string;
}

export interface DailyDriverReceiptV1 {
  schema_version: typeof DAILY_DRIVER_SCHEMA_VERSION;
  receipt_digest: string;
  trial_id: string;
  trial_suite_version: typeof DAILY_DRIVER_SUITE_VERSION;
  run_id: string;
  timestamp: string;
  model_id: string;
  provider_id: string;
  provider_route: string;
  reasoning_level: string;
  served_model_identity: string | null;
  hermes_version: string;
  hermes_commit: string;
  hermes_launcher_digest: string;
  terminal_sandbox_digest: string;
  runtime_policy_version: string;
  runtime_policy_digest: string;
  hermes_executable_digest: string;
  hermes_arguments: string[];
  requested_temperature: number | null;
  hermes_configuration_digest: string;
  system_prompt_digest: string;
  tool_registry_digest: string;
  fixture_digest: string;
  campaign_entropy_commitment: string;
  start_timestamp: string;
  end_timestamp: string;
  wall_clock_duration_ms: number;
  attempts: AttemptRecord[];
  retries: number;
  connection_failures: ConnectionFailure[];
  timeout_events: TimeoutEvent[];
  compaction_events: CompactionEvent[];
  input_tokens: number | null;
  output_tokens: number | null;
  charged_cost_usd: number | null;
  api_equivalent_cost_usd: number | null;
  plan_credit_consumed: number | null;
  subscription_quota_consumed: number | null;
  cost_rate_card_version: string;
  cost_provenance: "provider_actual" | "rate_card_estimate" | "subscription" | "token_plan" | "unknown";
  candidate_accommodations: string[];
  max_turns: number;
  max_output_tokens: number;
  limits_enforcement: "enforced" | "post_hoc";
  tool_calls: ToolCallRecord[];
  mutation_observations: MutationObservation[];
  deterministic_checks: DeterministicCheck[];
  raw_verdict: RawVerdict;
  evidence_references: EvidenceReference[];
  evidence_manifest_path: string;
  evidence_manifest_digest: string;
  evidence_bundle_mode: "receipt-plus-evidence-directory";
  redaction_events: RedactionEvent[];
  correction_rounds: number;
  accepted: boolean;
  disqualifier_codes: string[];
}

export class ContractValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Daily Driver receipt rejected: ${issues.join("; ")}`);
    this.name = "ContractValidationError";
  }
}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** RFC-8785-compatible for the JSON subset used by the contract. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

export function computeReceiptDigest(receipt: Omit<DailyDriverReceiptV1, "receipt_digest"> | DailyDriverReceiptV1): string {
  const { receipt_digest: _ignored, ...unsigned } = receipt as DailyDriverReceiptV1;
  return sha256(canonicalJson(unsigned));
}

export function sealReceipt(receipt: Omit<DailyDriverReceiptV1, "receipt_digest">): DailyDriverReceiptV1 {
  return { ...receipt, receipt_digest: computeReceiptDigest(receipt) };
}

const TOP_LEVEL_KEYS = [
  "schema_version", "receipt_digest", "trial_id", "trial_suite_version", "run_id", "timestamp",
  "model_id", "provider_id", "provider_route", "reasoning_level", "served_model_identity",
  "hermes_version", "hermes_commit", "hermes_launcher_digest", "terminal_sandbox_digest", "runtime_policy_version", "runtime_policy_digest", "hermes_executable_digest", "hermes_arguments", "requested_temperature", "hermes_configuration_digest", "system_prompt_digest",
  "tool_registry_digest", "fixture_digest", "campaign_entropy_commitment", "start_timestamp", "end_timestamp",
  "wall_clock_duration_ms", "attempts", "retries", "connection_failures", "timeout_events",
  "compaction_events", "input_tokens", "output_tokens", "charged_cost_usd", "api_equivalent_cost_usd", "plan_credit_consumed", "subscription_quota_consumed", "cost_rate_card_version", "cost_provenance", "candidate_accommodations", "max_turns", "max_output_tokens", "limits_enforcement", "tool_calls",
  "mutation_observations", "deterministic_checks", "raw_verdict", "evidence_references", "evidence_manifest_path", "evidence_manifest_digest", "evidence_bundle_mode", "redaction_events",
  "correction_rounds", "accepted", "disqualifier_codes",
] as const;

const SECRET_KEY = /(?:api[_-]?key|authorization|credential|password|private[_-]?key|access[_-]?token|refresh[_-]?token|secret)$/i;
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{12,}|(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*[^\s,;]{6,})/i;
const TRANSPORT_KINDS = new Set(["TIMEOUT", "CONNECTION_RESET", "DNS", "RATE_LIMIT", "UNAVAILABLE", "NETWORK", "HTTP_5XX"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, expected: readonly string[], at: string, issues: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) { issues.push(`${at} must be an object`); return false; }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  for (const key of actual) if (!wanted.includes(key)) issues.push(`${at}.${key} is not allowed`);
  for (const key of wanted) if (!actual.includes(key)) issues.push(`${at}.${key} is required`);
  return true;
}

function stringField(record: Record<string, unknown>, key: string, at: string, issues: string[], nullable = false): void {
  const value = record[key];
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) issues.push(`${at}.${key} must be a non-empty string${nullable ? " or null" : ""}`);
}

function numberField(record: Record<string, unknown>, key: string, at: string, issues: string[], nullable = false): void {
  const value = record[key];
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) issues.push(`${at}.${key} must be a non-negative finite number${nullable ? " or null" : ""}`);
}

function integerField(record: Record<string, unknown>, key: string, at: string, issues: string[], nullable = false, minimum = 0): void {
  const value = record[key];
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) issues.push(`${at}.${key} must be an integer >= ${minimum}${nullable ? " or null" : ""}`);
}

function arrayField(record: Record<string, unknown>, key: string, at: string, issues: string[]): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) { issues.push(`${at}.${key} must be an array`); return []; }
  return value;
}

function isoField(record: Record<string, unknown>, key: string, at: string, issues: string[]): void {
  stringField(record, key, at, issues);
  const value = record[key];
  if (typeof value === "string" && (!Number.isFinite(Date.parse(value)) || !value.endsWith("Z"))) issues.push(`${at}.${key} must be an ISO-8601 UTC timestamp`);
}

function digestField(record: Record<string, unknown>, key: string, at: string, issues: string[], nullable = false): void {
  const value = record[key];
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) issues.push(`${at}.${key} must be a sha256 digest`);
}

function scanSecrets(value: unknown, at: string, issues: string[]): void {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) issues.push(`${at} contains secret-shaped material`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scanSecrets(item, `${at}[${index}]`, issues)); return; }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) issues.push(`${at}.${key} is a forbidden secret-bearing key`);
    scanSecrets(nested, `${at}.${key}`, issues);
  }
}

export function validateReceipt(value: unknown): asserts value is DailyDriverReceiptV1 {
  const issues: string[] = validateCommittedReceiptSchema(value).map((issue) => `JSON Schema ${issue}`);
  if (!exactKeys(value, TOP_LEVEL_KEYS, "$", issues)) throw new ContractValidationError(issues);
  const r = value;
  for (const key of ["schema_version", "receipt_digest", "trial_id", "trial_suite_version", "run_id", "model_id", "provider_id", "provider_route", "reasoning_level", "hermes_version", "hermes_commit", "runtime_policy_version", "cost_rate_card_version", "evidence_manifest_path", "evidence_bundle_mode"] as const) stringField(r, key, "$", issues);
  if (r.schema_version !== DAILY_DRIVER_SCHEMA_VERSION) issues.push(`$.schema_version unsupported: ${String(r.schema_version)}`);
  if (r.trial_suite_version !== DAILY_DRIVER_SUITE_VERSION) issues.push(`$.trial_suite_version unsupported: ${String(r.trial_suite_version)}`);
  if (r.cost_rate_card_version !== DAILY_DRIVER_RATE_CARD_VERSION) issues.push(`$.cost_rate_card_version unsupported: ${String(r.cost_rate_card_version)}`);
  stringField(r, "served_model_identity", "$", issues, true);
  for (const key of ["receipt_digest", "hermes_launcher_digest", "terminal_sandbox_digest", "runtime_policy_digest", "hermes_executable_digest", "hermes_configuration_digest", "system_prompt_digest", "tool_registry_digest", "fixture_digest", "campaign_entropy_commitment", "evidence_manifest_digest"] as const) digestField(r, key, "$", issues);
  if (r.hermes_launcher_digest === r.terminal_sandbox_digest) issues.push("$.terminal_sandbox_digest must independently bind the terminal sandbox bytes");
  if (r.evidence_bundle_mode !== "receipt-plus-evidence-directory") issues.push("$.evidence_bundle_mode is unsupported");
  arrayField(r, "hermes_arguments", "$", issues).forEach((arg, index) => { if (typeof arg !== "string") issues.push(`$.hermes_arguments[${index}] must be a string`); });
  numberField(r, "requested_temperature", "$", issues, true);
  for (const key of ["timestamp", "start_timestamp", "end_timestamp"] as const) isoField(r, key, "$", issues);
  numberField(r, "wall_clock_duration_ms", "$", issues);
  for (const key of ["retries", "correction_rounds"] as const) integerField(r, key, "$", issues);
  for (const key of ["max_turns", "max_output_tokens"] as const) integerField(r, key, "$", issues, false, 1);
  for (const key of ["input_tokens", "output_tokens"] as const) integerField(r, key, "$", issues, true);
  for (const key of ["charged_cost_usd", "api_equivalent_cost_usd", "plan_credit_consumed", "subscription_quota_consumed"] as const) numberField(r, key, "$", issues, true);
  if (!["provider_actual", "rate_card_estimate", "subscription", "token_plan", "unknown"].includes(String(r.cost_provenance))) issues.push("$.cost_provenance is invalid");
  if (!["enforced", "post_hoc"].includes(String(r.limits_enforcement))) issues.push("$.limits_enforcement is invalid");
  arrayField(r, "candidate_accommodations", "$", issues).forEach((item, index) => { if (typeof item !== "string" || item.length === 0) issues.push(`$.candidate_accommodations[${index}] must be a non-empty string`); });
  if (typeof r.accepted !== "boolean") issues.push("$.accepted must be boolean");
  if (!["PASS", "FAIL", "SAFE_FAIL", "INCOMPLETE", "ERROR"].includes(String(r.raw_verdict))) issues.push("$.raw_verdict is invalid");

  const attempts = arrayField(r, "attempts", "$", issues);
  if (attempts.length === 0) issues.push("$.attempts must not be empty");
  attempts.forEach((item, index) => {
    const at = `$.attempts[${index}]`;
    if (!exactKeys(item, ["attempt", "started_at", "finished_at", "duration_ms", "exit_code", "outcome", "error_kind", "retryable", "stdout_digest", "stderr_digest", "timeout_stage", "signals_sent", "cleanup_outcome"], at, issues)) return;
    integerField(item, "attempt", at, issues, false, 1); numberField(item, "duration_ms", at, issues);
    isoField(item, "started_at", at, issues); isoField(item, "finished_at", at, issues);
    if (item.exit_code !== null && (!Number.isInteger(item.exit_code) || typeof item.exit_code !== "number")) issues.push(`${at}.exit_code must be integer or null`);
    if (!["accepted_output", "model_failure", "transport_failure", "timeout"].includes(String(item.outcome))) issues.push(`${at}.outcome is invalid`);
    if (item.error_kind !== null && typeof item.error_kind !== "string") issues.push(`${at}.error_kind must be string or null`);
    if (typeof item.retryable !== "boolean") issues.push(`${at}.retryable must be boolean`);
    digestField(item, "stdout_digest", at, issues); digestField(item, "stderr_digest", at, issues);
    if (!["none", "term_sent", "kill_sent", "drain_bounded"].includes(String(item.timeout_stage))) issues.push(`${at}.timeout_stage invalid`);
    arrayField(item, "signals_sent", at, issues).forEach((signal, n) => { if (!["SIGTERM", "SIGKILL"].includes(String(signal))) issues.push(`${at}.signals_sent[${n}] invalid`); });
    if (!["not_required", "group_terminated", "group_killed", "cleanup_unconfirmed"].includes(String(item.cleanup_outcome))) issues.push(`${at}.cleanup_outcome invalid`);
    if (item.attempt !== index + 1) issues.push(`${at}.attempt must be contiguous and one-based`);
    if (item.outcome === "model_failure" && typeof item.error_kind === "string" && TRANSPORT_KINDS.has(item.error_kind)) issues.push(`${at} transport error misreported as model_failure`);
    if ((item.outcome === "transport_failure" || item.outcome === "timeout") && (typeof item.error_kind !== "string" || !TRANSPORT_KINDS.has(item.error_kind))) issues.push(`${at} model/process failure misreported as transport_failure`);
  });
  if (typeof r.retries === "number" && attempts.length > 0 && r.retries !== attempts.length - 1) issues.push("$.retries must equal attempts.length - 1");

  const connections = arrayField(r, "connection_failures", "$", issues);
  connections.forEach((item, index) => {
    const at = `$.connection_failures[${index}]`;
    if (!exactKeys(item, ["attempt", "kind", "timestamp", "message"], at, issues)) return;
    integerField(item, "attempt", at, issues, false, 1); stringField(item, "kind", at, issues); isoField(item, "timestamp", at, issues); stringField(item, "message", at, issues);
    if (typeof item.kind === "string" && !TRANSPORT_KINDS.has(item.kind)) issues.push(`${at}.kind is not a transport failure`);
  });
  const timeouts = arrayField(r, "timeout_events", "$", issues);
  timeouts.forEach((item, index) => {
    const at = `$.timeout_events[${index}]`;
    if (!exactKeys(item, ["attempt", "timestamp", "timeout_ms", "phase", "stage", "signals_sent", "cleanup_outcome"], at, issues)) return;
    integerField(item, "attempt", at, issues, false, 1); isoField(item, "timestamp", at, issues); integerField(item, "timeout_ms", at, issues, false, 1);
    if (!["candidate_process", "validator"].includes(String(item.phase))) issues.push(`${at}.phase is invalid`);
    if (!["term_sent", "kill_sent", "drain_bounded"].includes(String(item.stage))) issues.push(`${at}.stage invalid`);
    arrayField(item, "signals_sent", at, issues);
    if (!["group_terminated", "group_killed", "cleanup_unconfirmed"].includes(String(item.cleanup_outcome))) issues.push(`${at}.cleanup_outcome invalid`);
  });
  const compactions = arrayField(r, "compaction_events", "$", issues);
  compactions.forEach((item, index) => {
    const at = `$.compaction_events[${index}]`;
    if (!exactKeys(item, ["attempt", "timestamp", "before_tokens", "after_tokens"], at, issues)) return;
    integerField(item, "attempt", at, issues, false, 1); isoField(item, "timestamp", at, issues); integerField(item, "before_tokens", at, issues, true); integerField(item, "after_tokens", at, issues, true);
  });
  const tools = arrayField(r, "tool_calls", "$", issues);
  tools.forEach((item, index) => {
    const at = `$.tool_calls[${index}]`;
    if (!exactKeys(item, ["attempt", "sequence", "name", "arguments_digest", "started_at", "finished_at", "exit_code", "timed_out"], at, issues)) return;
    integerField(item, "attempt", at, issues, false, 1); integerField(item, "sequence", at, issues, false, 1); stringField(item, "name", at, issues); digestField(item, "arguments_digest", at, issues); isoField(item, "started_at", at, issues);
    if (item.finished_at !== null) isoField(item, "finished_at", at, issues);
    if (item.exit_code !== null && (!Number.isInteger(item.exit_code) || typeof item.exit_code !== "number")) issues.push(`${at}.exit_code must be integer or null`);
    if (typeof item.timed_out !== "boolean") issues.push(`${at}.timed_out must be boolean`);
  });
  const mutations = arrayField(r, "mutation_observations", "$", issues);
  mutations.forEach((item, index) => {
    const at = `$.mutation_observations[${index}]`;
    if (!exactKeys(item, ["path", "kind", "allowed", "before_digest", "after_digest"], at, issues)) return;
    stringField(item, "path", at, issues);
    if (!["created", "modified", "deleted"].includes(String(item.kind))) issues.push(`${at}.kind is invalid`);
    if (typeof item.allowed !== "boolean") issues.push(`${at}.allowed must be boolean`);
    digestField(item, "before_digest", at, issues, true); digestField(item, "after_digest", at, issues, true);
  });
  const checks = arrayField(r, "deterministic_checks", "$", issues);
  checks.forEach((item, index) => {
    const at = `$.deterministic_checks[${index}]`;
    if (!exactKeys(item, ["id", "passed", "details", "evidence_refs"], at, issues)) return;
    stringField(item, "id", at, issues); stringField(item, "details", at, issues);
    if (typeof item.passed !== "boolean") issues.push(`${at}.passed must be boolean`);
    arrayField(item, "evidence_refs", at, issues).forEach((ref, refIndex) => { if (typeof ref !== "string") issues.push(`${at}.evidence_refs[${refIndex}] must be string`); });
  });
  const evidence = arrayField(r, "evidence_references", "$", issues);
  evidence.forEach((item, index) => {
    const at = `$.evidence_references[${index}]`;
    if (!exactKeys(item, ["id", "kind", "path", "digest"], at, issues)) return;
    stringField(item, "id", at, issues); stringField(item, "path", at, issues); digestField(item, "digest", at, issues);
    if (!["stdout", "stderr", "artifact", "fixture", "validator"].includes(String(item.kind))) issues.push(`${at}.kind is invalid`);
    if (typeof item.path === "string" && (path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes(".."))) issues.push(`${at}.path must be a safe relative path`);
  });
  arrayField(r, "redaction_events", "$", issues).forEach((item, index) => {
    const at = `$.redaction_events[${index}]`;
    if (!exactKeys(item, ["source", "kind", "classification", "match_digest"], at, issues)) return;
    stringField(item, "source", at, issues); stringField(item, "kind", at, issues); digestField(item, "match_digest", at, issues);
    if (!["confirmed_secret", "possible_sensitive"].includes(String(item.classification))) issues.push(`${at}.classification invalid`);
  });
  arrayField(r, "disqualifier_codes", "$", issues).forEach((code, index) => { if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(code)) issues.push(`$.disqualifier_codes[${index}] is invalid`); });
  if (r.accepted === true && r.raw_verdict !== "PASS") issues.push("$.accepted may only be true for raw_verdict PASS");
  if (r.accepted === true && Array.isArray(r.disqualifier_codes) && r.disqualifier_codes.length > 0) issues.push("$.accepted receipt cannot have disqualifiers");
  if (r.accepted === true && checks.some((item) => isRecord(item) && item.passed !== true)) issues.push("$.accepted receipt cannot contain failed deterministic checks");
  if (r.accepted === true && mutations.some((item) => isRecord(item) && item.allowed !== true)) issues.push("$.accepted receipt cannot contain forbidden mutation");
  if (r.accepted === true && evidence.length === 0) issues.push("$.accepted receipt requires retained evidence");
  if (r.accepted === true && (r.served_model_identity === null || r.served_model_identity !== r.model_id)) issues.push("$.served_model_identity must match model_id for accepted receipts");
  const evidenceIds = new Set(evidence.filter(isRecord).map((item) => item.id).filter((id): id is string => typeof id === "string"));
  checks.forEach((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.evidence_refs)) return;
    item.evidence_refs.forEach((ref, refIndex) => { if (typeof ref === "string" && !evidenceIds.has(ref)) issues.push(`$.deterministic_checks[${index}].evidence_refs[${refIndex}] does not identify exported evidence`); });
  });
  scanSecrets(r, "$", issues);
  if (typeof r.receipt_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(r.receipt_digest)) {
    const computed = computeReceiptDigest(r as unknown as DailyDriverReceiptV1);
    if (computed !== r.receipt_digest) issues.push("$.receipt_digest does not match canonical receipt content");
  }
  if (issues.length > 0) throw new ContractValidationError(issues);
}

/** Application-write-once and digest-sealed. Filesystem immutability is not claimed. */
/** Application-write-once export; the canonical digest makes later filesystem tampering evident. */
export async function writeOnceReceipt(receipt: DailyDriverReceiptV1, outputRoot: string): Promise<string> {
  validateReceipt(receipt);
  const dir = path.join(outputRoot, "receipts", receipt.run_id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${receipt.trial_id}.${receipt.receipt_digest.slice(7)}.json`);
  const handle = await fs.open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o444);
  try {
    await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return filePath;
}
