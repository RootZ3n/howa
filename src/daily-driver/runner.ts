import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../velum/redaction.js";
import {
  DAILY_DRIVER_SCHEMA_VERSION,
  DAILY_DRIVER_SUITE_VERSION,
  canonicalJson,
  sealReceipt,
  sha256,
  writeOnceReceipt,
  type AttemptRecord,
  type CompactionEvent,
  type ConnectionFailure,
  type DailyDriverReceiptV1,
  type EvidenceReference,
  type MutationObservation,
  type TimeoutEvent,
  type ToolCallRecord,
} from "./contract.js";
import { createAuthoritativeFixture, createCampaignEntropy, observeMutations, snapshotFixture, type CampaignEntropy } from "./fixtures.js";
import { getDailyDriverTrial, HERMES_DAILY_DRIVER_V1, type DailyDriverTrial } from "./suite.js";
import { validateTrialResult } from "./validators.js";
import { apiEquivalentCost, DAILY_DRIVER_RATE_CARD_VERSION, lookupRate } from "./rate-card.js";
import { buildEvidenceManifest } from "./evidence.js";
import { rejectCandidateRuntimeOverrides, resolveTrustedRuntime } from "./runtime-policy.js";
import { AUTHORITY_SCHEMA_VERSION, trustedExpectedEvidence } from "./expected-authority.js";

export interface DailyDriverCandidate {
  model_id: string;
  provider_id: string;
  provider_route: string;
  reasoning_level: string;
  temperature?: number;
  /** Deprecated and always rejected. The frozen runtime policy owns these identities. */
  hermes_command?: string;
  hermes_executable_path?: string;
  hermes_install_root?: string;
  /** No shell is used. Supported placeholders: {prompt}, {prompt_file}, {usage_file}, {workspace}, {session_root}, {trial_id}. */
  hermes_args: string[];
  hermes_version?: string;
  hermes_commit?: string;
  /** Public, secret-free configuration descriptor used only for a digest. */
  hermes_configuration: Record<string, unknown>;
  provider_credential_env?: "MINIMAX_API_KEY" | "MIMO_API_KEY" | "OPENAI_API_KEY" | "HOWA_OPENAI_CODEX_AUTH_BUNDLE";
  candidate_accommodations?: string[];
  trusted_offline_reference?: never;
  max_turns?: number;
  max_output_tokens?: number;
  limits_enforcement?: "enforced" | "post_hoc";
  max_correction_rounds?: number;
  max_attempts?: number;
  require_usage_file?: boolean;
  require_transcript?: boolean;
  max_trial_cost_usd?: number;
  max_campaign_cost_usd?: number;
  canary_trial_ids?: string[];
  max_canary_cost_usd?: number;
}

export interface RunDailyDriverOptions {
  candidate: DailyDriverCandidate;
  output_root: string;
  run_id: string;
  trial_ids?: string[];
  keep_fixtures?: boolean;
  /** Trusted evaluator state. The CLI never accepts this field. */
  campaign_entropy?: CampaignEntropy;
  /** Test harness only; never deserialized by the production CLI. */
  timeout_override_ms?: number;
}

export interface TrialRunResult {
  receipt: DailyDriverReceiptV1;
  receipt_path: string;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutStage: "none" | "term_sent" | "kill_sent" | "drain_bounded";
  signalsSent: Array<"SIGTERM" | "SIGKILL">;
  cleanupOutcome: "not_required" | "group_terminated" | "group_killed" | "cleanup_unconfirmed";
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
function redactSecrets(value: string, source = "unknown", sentinels: string[] = []): { text: string; confirmed: boolean; events: Array<{ source: string; kind: string; classification: "confirmed_secret" | "possible_sensitive"; match_digest: string }> } {
  const result = redact(value);
  let text=result.redacted; const events=result.matches.map((match) => ({ source, kind: match.kind, classification: match.classification, match_digest: sha256(value.slice(match.start, match.end)) }));
  for(const sentinel of sentinels.filter((item)=>item.length>=6)){ if(value.includes(sentinel)){ text=text.split(sentinel).join("[REDACTED:provider_credential_sentinel]"); events.push({source,kind:"provider_credential_sentinel",classification:"confirmed_secret" as const,match_digest:sha256(sentinel)}); } }
  return { text, confirmed: events.some((match) => match.classification === "confirmed_secret"), events };
}

function providerSecretSentinels(candidate: DailyDriverCandidate): string[] { const raw=candidate.provider_credential_env?process.env[candidate.provider_credential_env]:undefined; if(!raw)return[]; if(candidate.provider_credential_env!=="HOWA_OPENAI_CODEX_AUTH_BUNDLE")return[raw]; try{const v=JSON.parse(raw) as Record<string,unknown>; return [v.access_token,v.refresh_token].filter((x):x is string=>typeof x==="string");}catch{return[raw];} }

function assertCandidate(candidate: DailyDriverCandidate): void {
  rejectCandidateRuntimeOverrides(candidate as unknown as Record<string, unknown>);
  for (const [key, value] of Object.entries({
    model_id: candidate.model_id, provider_id: candidate.provider_id, provider_route: candidate.provider_route,
    reasoning_level: candidate.reasoning_level,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`candidate.${key} is required`);
  }
  if (!Array.isArray(candidate.hermes_args) || candidate.hermes_args.some((value) => typeof value !== "string")) throw new Error("candidate.hermes_args must be a string array");
  if (candidate.provider_id !== "offline" && candidate.require_usage_file === true && !candidate.hermes_args.some((value) => value.includes("{usage_file}"))) throw new Error("candidate.require_usage_file requires a {usage_file} argument placeholder");
  for (const [key, value] of Object.entries({ max_trial_cost_usd: candidate.max_trial_cost_usd, max_campaign_cost_usd: candidate.max_campaign_cost_usd, max_canary_cost_usd: candidate.max_canary_cost_usd })) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`candidate.${key} must be a positive finite number`);
  }
  const serialized = canonicalJson(candidate.hermes_configuration);
  if (redactSecrets(serialized).confirmed) throw new Error("candidate.hermes_configuration must not contain credentials or secrets");
  if (candidate.provider_id !== "offline" && !candidate.provider_credential_env) throw new Error("candidate.provider_credential_env binds the single allowed provider credential");
  const credentialByProvider: Record<string, DailyDriverCandidate["provider_credential_env"]> = { minimax: "MINIMAX_API_KEY", xiaomi: "MIMO_API_KEY", "openai-codex": "HOWA_OPENAI_CODEX_AUTH_BUNDLE" };
  if (candidate.provider_id !== "offline" && credentialByProvider[candidate.provider_id] !== candidate.provider_credential_env) throw new Error(`candidate.provider_credential_env does not match provider ${candidate.provider_id}`);
  if (candidate.max_turns !== undefined && (!Number.isInteger(candidate.max_turns) || candidate.max_turns < 1)) throw new Error("candidate.max_turns must be a positive integer");
  if (candidate.max_output_tokens !== undefined && (!Number.isInteger(candidate.max_output_tokens) || candidate.max_output_tokens < 1)) throw new Error("candidate.max_output_tokens must be a positive integer");
  if (candidate.canary_trial_ids && (new Set(candidate.canary_trial_ids).size !== candidate.canary_trial_ids.length || candidate.canary_trial_ids.length !== 3 || candidate.canary_trial_ids.some((id) => !HERMES_DAILY_DRIVER_V1.trials.some((trial) => trial.id === id)))) throw new Error("candidate.canary_trial_ids must contain exactly three unique suite trials");
  if (candidate.provider_id === "offline" && candidate.provider_credential_env) throw new Error("offline proof candidates cannot receive provider credentials");
}

function buildPrompt(trial: DailyDriverTrial): string {
  return [
    "You are being evaluated inside a synthetic temporary fixture. Never access paths outside the current workspace.",
    `Trial: ${trial.id} — ${trial.title}`,
    `Task: ${trial.task}`,
    `Permitted tools: ${trial.permitted_tools.join(", ") || "none"}`,
    `Allowed mutations: ${trial.mutation_boundary.allowed.join(", ") || "none"}`,
    `Forbidden mutations: ${trial.mutation_boundary.forbidden.join(", ") || "none"}`,
    `Timeout: ${trial.timeout_ms}ms`,
    "Return exactly one JSON object and no prose. The object must have only these keys:",
    canonicalJson(trial.expected_output_schema),
    "Your status is a claim only. Howa's deterministic validator, not you, assigns the trial verdict.",
  ].join("\n\n");
}

function substituteArgs(args: string[], values: Record<string, string>): string[] {
  return args.map((arg) => arg.replace(/\{(prompt|prompt_file|usage_file|workspace|session_root|trial_id)\}/g, (_match, key: string) => values[key] ?? ""));
}

interface HermesUsage {
  estimated_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  provider: string | null;
}

async function readUsage(filePath: string): Promise<HermesUsage | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    const numeric = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? value[key] as number : null;
    return { estimated_cost_usd: numeric("estimated_cost_usd"), input_tokens: numeric("input_tokens"), output_tokens: numeric("output_tokens"), model: typeof value.model === "string" ? value.model : null, provider: typeof value.provider === "string" ? value.provider : null };
  } catch {
    return null;
  }
}

interface TranscriptRow {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  effect_disposition: string | null;
  timestamp: number;
  token_count: number | null;
  finish_reason: string | null;
  compacted: number;
}

async function captureHermesTranscript(sessionRoot: string): Promise<TranscriptRow[] | null> {
  const dbPath = path.join(sessionRoot, "state.db");
  try { await fs.access(dbPath); } catch { return null; }
  const query = "SELECT id,role,content,tool_call_id,tool_calls,tool_name,effect_disposition,timestamp,token_count,finish_reason,compacted FROM messages ORDER BY id";
  const result = await runProcess("sqlite3", ["-json", "-readonly", dbPath, query], sessionRoot, 5_000, sessionRoot);
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed as TranscriptRow[] : null;
  } catch { return null; }
}

function transcriptTelemetry(rows: TranscriptRow[], attempt: number): { tools: ToolCallRecord[]; paths: string[] } {
  const resultRows = new Map(rows.filter((row) => row.tool_call_id).map((row) => [row.tool_call_id as string, row]));
  const tools: ToolCallRecord[] = [];
  const paths: string[] = [];
  let sequence = 0;
  const collectPaths = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectPaths); return; }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (["path", "file", "cwd", "url", "command", "query"].includes(key) && typeof child === "string") paths.push(child);
      else collectPaths(child);
    }
  };
  for (const row of rows) {
    if (!row.tool_calls) continue;
    try {
      const calls = JSON.parse(row.tool_calls) as unknown;
      if (!Array.isArray(calls)) continue;
      for (const raw of calls) {
        if (!isRecord(raw)) continue;
        const fn = isRecord(raw.function) ? raw.function : raw;
        let args: unknown = fn.arguments ?? raw.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { raw: args }; } }
        collectPaths(args);
        const id = typeof raw.id === "string" ? raw.id : "";
        const outcome = resultRows.get(id);
        const outcomeValue = outcome?.content ? (() => { try { return JSON.parse(outcome.content); } catch { return {}; } })() : {};
        const timestamp = Number(row.timestamp);
        tools.push({
          attempt,
          sequence: ++sequence,
          name: String(fn.name ?? raw.name ?? "unknown"),
          arguments_digest: sha256(canonicalJson(args)),
          started_at: Number.isFinite(timestamp) ? new Date(timestamp * 1_000).toISOString() : new Date(0).toISOString(),
          finished_at: outcome && Number.isFinite(Number(outcome.timestamp)) ? new Date(Number(outcome.timestamp) * 1_000).toISOString() : null,
          exit_code: isRecord(outcomeValue) && typeof outcomeValue.exit_code === "number" ? outcomeValue.exit_code : null,
          timed_out: isRecord(outcomeValue) && outcomeValue.timed_out === true,
        });
      }
    } catch { /* The raw transcript remains evidence even when a provider emitted malformed tool JSON. */ }
  }
  return { tools, paths };
}

function trustedChildEnv(candidate: DailyDriverCandidate, cwd: string, captureRoot: string, attempt: number, trialId: string): NodeJS.ProcessEnv {
  const offlineScenarios: Record<string,string>={"offline/mock-v2":"reference","offline/static-key-v1":"static","offline/timeout-v1":"timeout","offline/forge-v1":"forge","offline/hash-v1":"hash","offline/retry-v1":"retry","offline/malformed-v1":"malformed","offline/secret-v1":"secret","offline/correction-v1":"correction"};
  const env: NodeJS.ProcessEnv = {
    PATH: "/home/zen/.local/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOWA_DAILY_DRIVER: "1", HOWA_DAILY_DRIVER_WORKSPACE: cwd, HOWA_DAILY_DRIVER_CAPTURE_ROOT: captureRoot,
    HOWA_ATTEMPT: String(attempt), GIT_OPTIONAL_LOCKS: "0", HERMES_HOME: captureRoot,
    HOWA_TRIAL_ID: trialId, HOWA_TRUSTED_RUNTIME_KIND: candidate.provider_id === "offline" ? "offline-proof" : "production-hermes",
    HERMES_SESSION_DIR: captureRoot, HERMES_STATE_DIR: captureRoot, XDG_CACHE_HOME: path.join(captureRoot, "cache"),
    XDG_CONFIG_HOME: path.join(captureRoot, "config"), XDG_DATA_HOME: path.join(captureRoot, "data"), TMPDIR: path.join(captureRoot, "tmp"),
    HOWA_MAX_TURNS: String(candidate.max_turns ?? 24), HOWA_MAX_OUTPUT_TOKENS: String(candidate.max_output_tokens ?? 8192),
  };
  if(candidate.provider_id==="offline"){ const scenario=offlineScenarios[candidate.model_id]; if(!scenario) throw new Error(`offline model is not frozen in runtime policy: ${candidate.model_id}`); env.HOWA_TRUSTED_OFFLINE_SCENARIO=scenario; env.HOWA_REQUESTED_MODEL_ID=candidate.model_id; }
  if (candidate.provider_credential_env) {
    const value = process.env[candidate.provider_credential_env];
    if (!value) throw new Error(`required provider credential ${candidate.provider_credential_env} is unavailable`);
    env.HOWA_PROVIDER_CREDENTIAL_NAME = candidate.provider_credential_env;
    env[candidate.provider_credential_env] = value;
  }
  return env;
}

export async function mintTrustedProviderCredential(candidate: DailyDriverCandidate, captureRoot: string): Promise<void> {
  if (candidate.provider_credential_env !== "HOWA_OPENAI_CODEX_AUTH_BUNDLE") return;
  const raw = process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE;
  let bundle: unknown;
  try { bundle = JSON.parse(raw ?? ""); } catch { throw new Error("HOWA_OPENAI_CODEX_AUTH_BUNDLE must be valid JSON"); }
  if (!isRecord(bundle) || Object.keys(bundle).some((key) => !["access_token", "refresh_token"].includes(key)) || typeof bundle.access_token !== "string" || bundle.access_token.length < 20 || typeof bundle.refresh_token !== "string" || bundle.refresh_token.length < 20) {
    throw new Error("HOWA_OPENAI_CODEX_AUTH_BUNDLE must contain only nonempty access_token and refresh_token fields");
  }
  const auth = { version: 1, active_provider: "openai-codex", providers: { "openai-codex": { tokens: { access_token: bundle.access_token, refresh_token: bundle.refresh_token } } } };
  await fs.writeFile(path.join(captureRoot, "auth.json"), `${JSON.stringify(auth)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, captureRoot: string, candidate?: DailyDriverCandidate, attempt = 1, trialId = "internal"): Promise<ProcessResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let timeoutStage: ProcessResult["timeoutStage"] = "none";
  const signalsSent: ProcessResult["signalsSent"] = [];
  let cleanupOutcome: ProcessResult["cleanupOutcome"] = "not_required";
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: candidate ? trustedChildEnv(candidate, cwd, captureRoot, attempt, trialId) : { PATH: "/usr/bin:/bin", HOME: captureRoot, LANG: "C.UTF-8" },
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
      signalsSent.push(signal);
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutStage = "term_sent";
      stderr += `\nHowa: candidate timeout after ${timeoutMs}ms`;
      signalGroup("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        timeoutStage = "kill_sent"; cleanupOutcome = "group_killed"; signalGroup("SIGKILL");
        setTimeout(() => {
          if (settled) return;
          timeoutStage = "drain_bounded"; child.stdout.destroy(); child.stderr.destroy(); cleanupOutcome = "group_killed"; finish(124);
        }, 300);
      }, 300);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_CAPTURE_BYTES - stdout.length); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_CAPTURE_BYTES - stderr.length); });
    child.once("error", (error) => { stderr += `\nHowa spawn error: ${error.message}`; finish(127); });
    child.once("close", (code) => { if (timedOut) { cleanupOutcome = signalsSent.includes("SIGKILL") ? "group_killed" : "group_terminated"; finish(124); } else finish(code); });
  });
  const finished = Date.now();
  return { stdout, stderr, exitCode, timedOut, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, timeoutStage, signalsSent, cleanupOutcome };
}

function classifyTransport(result: ProcessResult): { transport: boolean; kind: string | null; retryable: boolean } {
  if (result.timedOut || result.exitCode === 124) return { transport: true, kind: "TIMEOUT", retryable: true };
  const structural: Record<number, string> = { 69: "UNAVAILABLE", 70: "CONNECTION_RESET", 71: "DNS", 75: "RATE_LIMIT", 76: "HTTP_5XX" };
  if (result.exitCode !== null && structural[result.exitCode]) return { transport: true, kind: structural[result.exitCode]!, retryable: true };
  return { transport: false, kind: result.exitCode === 0 ? null : "MODEL_OR_PROCESS_FAILURE", retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function runtimeComponentDigest(candidate: DailyDriverCandidate, relativePaths: string[], fallback: unknown): Promise<string> {
  const installRoot = candidate.provider_id === "offline" ? null : "/home/zen/.hermes/hermes-agent";
  if (!installRoot) return sha256(canonicalJson(fallback));
  const components: Array<{ path: string; digest: string }> = [];
  for (const relative of relativePaths) {
    const target = path.resolve(installRoot, relative);
    const root = `${path.resolve(installRoot)}${path.sep}`;
    if (!target.startsWith(root)) throw new Error(`Hermes runtime component escapes install root: ${relative}`);
    components.push({ path: relative, digest: sha256(await fs.readFile(target)) });
  }
  return sha256(canonicalJson(components));
}

interface OfflineTelemetry { schema_version: string; model: string; provider: string; input_tokens: number; output_tokens: number; tool_rows: Array<{ sequence:number; command:string; started:number; finished:number; exit_code:number|null }> }
async function captureOfflineTelemetry(sessionRoot: string, attempt: number): Promise<{ usage: HermesUsage; tools: ToolCallRecord[]; paths: string[] } | null> {
  try {
    const value=JSON.parse(await fs.readFile(path.join(sessionRoot,"trusted-telemetry.json"),"utf8")) as OfflineTelemetry;
    if(value.schema_version!=="howa.offline-telemetry.v1"||!Array.isArray(value.tool_rows)) return null;
    return { usage:{estimated_cost_usd:0,input_tokens:value.input_tokens,output_tokens:value.output_tokens,model:value.model,provider:value.provider}, paths:value.tool_rows.map((row)=>row.command), tools:value.tool_rows.map((row)=>({attempt,sequence:row.sequence,name:"terminal",arguments_digest:sha256(canonicalJson({command:row.command})),started_at:new Date(row.started*1000).toISOString(),finished_at:new Date(row.finished*1000).toISOString(),exit_code:row.exit_code,timed_out:false})) };
  } catch { return null; }
}

async function writeEvidence(outputRoot: string, relative: string, content: string, explicitKind?: EvidenceReference["kind"], mode = 0o444): Promise<EvidenceReference> {
  const target = path.join(outputRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
  const name = path.basename(relative);
  const kind: EvidenceReference["kind"] = explicitKind ?? (name.includes("stdout") ? "stdout" : name.includes("stderr") ? "stderr" : name.includes("fixture") ? "fixture" : name.includes("validator") ? "validator" : "artifact");
  return { id: name.replace(/[^a-z0-9_.-]/gi, "_"), kind, path: relative.split(path.sep).join("/"), digest: sha256(content) };
}

function prefixMutations(attempt: number, values: MutationObservation[]): MutationObservation[] {
  return values.map((item) => ({ ...item, path: `attempt-${attempt}/${item.path}` }));
}

export async function runDailyDriverTrial(options: RunDailyDriverOptions, trialId: string): Promise<TrialRunResult> {
  assertCandidate(options.candidate);
  if (!/^[A-Za-z0-9_.-]+$/.test(options.run_id)) throw new Error("run_id must contain only letters, digits, dot, underscore, and hyphen");
  const trial = getDailyDriverTrial(trialId);
  const entropy = options.campaign_entropy ?? createCampaignEntropy(options.run_id);
  if (entropy.run_id !== options.run_id) throw new Error("campaign entropy run identity mismatch");
  const runtime = await resolveTrustedRuntime(options.candidate.provider_id);
  const runStartedMs = Date.now();
  const startTimestamp = new Date(runStartedMs).toISOString();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `howa-ddv1-${options.run_id}-${trialId}-`));
  const captureRoots: string[] = [];
  const prompt = buildPrompt(trial);
  const promptFile = path.join(tempRoot, "prompt.txt");
  await fs.writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o400 });
  const attempts: AttemptRecord[] = [];
  const connectionFailures: ConnectionFailure[] = [];
  const timeoutEvents: TimeoutEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const allMutations: MutationObservation[] = [];
  const evidence: EvidenceReference[] = [];
  let fixtureDigest = "";
  let authorityDigest = "";
  let expectedObjectDigest = "";
  let validatorCheckSetDigest = "";
  let requiredSourcesDigest = "";
  let finalValidation: Awaited<ReturnType<typeof validateTrialResult>> | null = null;
  let secretExposure = false;
  const redactionEvents: DailyDriverReceiptV1["redaction_events"] = [];
  const secretSentinels = providerSecretSentinels(options.candidate);
  let usageMissing = false;
  let usageIdentityMismatch = false;
  let transcriptMissing = false;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let tokensReported = true;
  let servedModelIdentity: string | null = null;
  let authoritativeArgs: string[] = [];
  let correctionRounds = 0;
  const observedCompactions: CompactionEvent[] = [];
  const maxAttempts = Math.min(3, Math.max(1, Math.floor(options.candidate.max_attempts ?? 1)));
  const maxCorrections = Math.min(2, Math.max(0, Math.floor(options.candidate.max_correction_rounds ?? 0)));
  const promptImplementationDigest = await runtimeComponentDigest(options.candidate, ["agent/prompt_builder.py"], { offline: true, prompt_builder: "Howa buildPrompt" });
  const toolImplementationDigest = await runtimeComponentDigest(options.candidate, ["toolsets.py", "model_tools.py", "tools/terminal_tool.py"], { offline: true, tools: trial.permitted_tools });

  try {
    const totalAttemptLimit = maxAttempts + maxCorrections;
    for (let attempt = 1; attempt <= totalAttemptLimit; attempt++) {
      const workspace = path.join(tempRoot, `fixture-attempt-${attempt}`);
      const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), `howa-ddv1-capture-${options.run_id}-${trialId}-${attempt}-`));
      captureRoots.push(sessionRoot);
      const usageFile = path.join(sessionRoot, "usage.json");
      await Promise.all(["cache", "config", "data", "tmp"].map((name) => fs.mkdir(path.join(sessionRoot, name), { recursive: true, mode: 0o700 })));
      await mintTrustedProviderCredential(options.candidate, sessionRoot);
      const fixture = await createAuthoritativeFixture(workspace, trialId, entropy);
      const before = fixture.snapshot;
      if (!fixtureDigest) fixtureDigest = before.digest;
      else if (fixtureDigest !== before.digest) throw new Error(`fixture ${trialId} is not deterministic across attempts`);
      if (!authorityDigest) authorityDigest = fixture.authority.authority_digest;
      else if (authorityDigest !== fixture.authority.authority_digest) throw new Error(`fixture authority ${trialId} is not deterministic across attempts`);
      if (!expectedObjectDigest) expectedObjectDigest = fixture.authority.expected_object_digest;
      else if (expectedObjectDigest !== fixture.authority.expected_object_digest) throw new Error(`expected object ${trialId} is not deterministic across attempts`);
      if (!validatorCheckSetDigest) validatorCheckSetDigest = fixture.authority.validator_check_set_digest;
      else if (validatorCheckSetDigest !== fixture.authority.validator_check_set_digest) throw new Error(`validator check set ${trialId} changed across attempts`);
      if (!requiredSourcesDigest) requiredSourcesDigest = fixture.authority.required_sources_digest;
      else if (requiredSourcesDigest !== fixture.authority.required_sources_digest) throw new Error(`required sources ${trialId} changed across attempts`);
      const evidenceBase = path.join("artifacts", options.run_id, trialId);
      const expectedDocument = trustedExpectedEvidence({
        run_id: options.run_id,
        trial_id: trialId,
        attempt,
        fixture_digest: fixture.authority.fixture_digest,
        entropy_commitment: entropy.commitment,
        expected: fixture.authority.expected,
        expected_object_digest: fixture.authority.expected_object_digest,
        validator_check_set_digest: fixture.authority.validator_check_set_digest,
        required_sources_digest: fixture.authority.required_sources_digest,
        authority_digest: fixture.authority.authority_digest,
      });
      const expectedBytes = `${canonicalJson(expectedDocument)}\n`;
      const expectedScan = redactSecrets(expectedBytes, `attempt-${attempt}.trusted-expected`, secretSentinels);
      if (expectedScan.text !== expectedBytes || expectedScan.events.length > 0) throw new Error(`trusted expected evidence failed secret scan for ${trialId}; retention aborted rather than altering validator semantics`);
      const expectedEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.trusted-expected.json`), expectedBytes, "trusted_expected", 0o400);
      evidence.push(expectedEvidence);
      const args = substituteArgs(options.candidate.hermes_args, { prompt, prompt_file: promptFile, usage_file: usageFile, workspace, session_root: sessionRoot, trial_id: trialId });
      if (authoritativeArgs.length === 0) authoritativeArgs = args;
      const effectiveTimeout = options.timeout_override_ms === undefined ? trial.timeout_ms : Math.max(100, Math.min(trial.timeout_ms, options.timeout_override_ms));
      const processResult = await runProcess(runtime.launcher_path, args, workspace, effectiveTimeout, sessionRoot, options.candidate, attempt, trialId);
      const offlineTelemetry = options.candidate.provider_id === "offline" ? await captureOfflineTelemetry(sessionRoot, attempt) : null;
      const usage = offlineTelemetry?.usage ?? await readUsage(usageFile);
      if (!usage) {
        usageMissing ||= options.candidate.require_usage_file === true && !classifyTransport(processResult).transport;
        if (options.candidate.provider_id !== "offline") tokensReported = false;
        else servedModelIdentity = options.candidate.model_id;
      } else {
        if (usage.input_tokens === null || usage.output_tokens === null) tokensReported = false;
        else { totalInputTokens += usage.input_tokens; totalOutputTokens += usage.output_tokens; }
        if (usage.model) {
          servedModelIdentity = usage.model;
          if (usage.model !== options.candidate.model_id) usageIdentityMismatch = true;
        }
        if (usage.provider && usage.provider !== options.candidate.provider_id) usageIdentityMismatch = true;
      }
      const after = await snapshotFixture(workspace);
      const mutations = observeMutations(before, after, trial.mutation_boundary.allowed);
      allMutations.push(...prefixMutations(attempt, mutations));
      const transcript = options.candidate.provider_id === "offline" ? null : await captureHermesTranscript(sessionRoot);
      transcriptMissing ||= transcript === null && options.candidate.require_transcript === true;
      const telemetry = transcript ? transcriptTelemetry(transcript, attempt) : offlineTelemetry ? { paths: offlineTelemetry.paths, tools: offlineTelemetry.tools } : { paths: [], tools: [] };
      if (transcript?.some((row) => row.compacted === 1)) {
        const compacted = transcript.filter((row) => row.compacted === 1);
        const timestamp = Math.max(...compacted.map((row) => Number(row.timestamp)).filter(Number.isFinite));
        const tokens = compacted.map((row) => row.token_count).filter((value): value is number => typeof value === "number").reduce((sum, value) => sum + value, 0);
        observedCompactions.push({ attempt, timestamp: Number.isFinite(timestamp) ? new Date(timestamp * 1_000).toISOString() : processResult.finishedAt, before_tokens: tokens || null, after_tokens: null });
      }
      toolCalls.push(...telemetry.tools);
      const transport = classifyTransport(processResult);
      const stdoutRedacted = redactSecrets(processResult.stdout, `attempt-${attempt}.stdout`,secretSentinels);
      const stderrRedacted = redactSecrets(processResult.stderr, `attempt-${attempt}.stderr`,secretSentinels);
      redactionEvents.push(...stdoutRedacted.events,...stderrRedacted.events);
      secretExposure ||= stdoutRedacted.confirmed || stderrRedacted.confirmed;
      const stdoutEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.stdout.txt`), stdoutRedacted.text);
      const stderrEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.stderr.txt`), stderrRedacted.text);
      evidence.push(stdoutEvidence, stderrEvidence);
      evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.fixture-before.json`), `${canonicalJson(before)}\n`));
      evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.fixture-after.json`), `${canonicalJson(after)}\n`));
      if (usage) { const safeUsage=redactSecrets(`${canonicalJson(usage)}\n`,`attempt-${attempt}.usage`,secretSentinels); redactionEvents.push(...safeUsage.events); secretExposure||=safeUsage.confirmed; evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-usage.json`), safeUsage.text)); }
      if (offlineTelemetry) {
        const sanitized = redactSecrets(`${canonicalJson({paths:offlineTelemetry.paths,tools:offlineTelemetry.tools})}\n`, `attempt-${attempt}.tool-state`, secretSentinels);
        redactionEvents.push(...sanitized.events); secretExposure ||= sanitized.confirmed;
        evidence.push(await writeEvidence(options.output_root,path.join(evidenceBase,`attempt-${attempt}.trusted-tool-telemetry.json`),sanitized.text));
      }
      if (transcript) {
        const sanitized = redactSecrets(`${canonicalJson(transcript)}\n`, `attempt-${attempt}.tool-state`,secretSentinels);
        redactionEvents.push(...sanitized.events); secretExposure ||= sanitized.confirmed;
        evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-transcript.json`), sanitized.text));
      } else {
        evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-transcript.json`), `${canonicalJson({ available: false, reason: "isolated Hermes state.db unavailable" })}\n`));
      }
      const outcome: AttemptRecord["outcome"] = processResult.timedOut ? "timeout" : transport.transport ? "transport_failure" : processResult.exitCode === 0 ? "accepted_output" : "model_failure";
      attempts.push({ attempt, started_at: processResult.startedAt, finished_at: processResult.finishedAt, duration_ms: processResult.durationMs, exit_code: processResult.exitCode, outcome, error_kind: transport.kind, retryable: transport.retryable, stdout_digest: stdoutEvidence.digest, stderr_digest: stderrEvidence.digest, timeout_stage: processResult.timeoutStage, signals_sent: processResult.signalsSent, cleanup_outcome: processResult.cleanupOutcome });
      if (transport.transport) {
        connectionFailures.push({ attempt, kind: transport.kind ?? "UNKNOWN", timestamp: processResult.finishedAt, message: `candidate attempt ${attempt} ended with ${transport.kind ?? "transport failure"}` });
        if (processResult.timedOut) timeoutEvents.push({ attempt, timestamp: processResult.finishedAt, timeout_ms: effectiveTimeout, phase: "candidate_process", stage: processResult.timeoutStage === "none" ? "term_sent" : processResult.timeoutStage, signals_sent: processResult.signalsSent, cleanup_outcome: processResult.cleanupOutcome === "not_required" ? "cleanup_unconfirmed" : processResult.cleanupOutcome });
        if (transport.retryable && attempts.filter((item) => item.outcome === "transport_failure" || item.outcome === "timeout").length < maxAttempts) continue;
        break;
      }
      finalValidation = await validateTrialResult({ trial, workspace, stdout: processResult.stdout, mutations, observed_tool_paths: telemetry.paths, authority: fixture.authority });
      attempts[attempts.length - 1]!.outcome = finalValidation.accepted ? "accepted_output" : "model_failure";
      attempts[attempts.length - 1]!.error_kind = finalValidation.accepted ? null : "MODEL_OUTPUT_REJECTED";
      attempts[attempts.length - 1]!.retryable = !finalValidation.accepted && correctionRounds < maxCorrections;
      const evidenceIdFor = (alias: string): string => {
        if (alias === "candidate.stdout") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.stdout.txt`))?.id ?? alias;
        if (alias === "fixture.before") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.fixture-before.json`))?.id ?? alias;
        if (alias === "fixture.after") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.fixture-after.json`))?.id ?? alias;
        if (alias === "hermes.transcript") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.hermes-transcript.json`))?.id ?? alias;
        if (alias === "trusted.expected") return expectedEvidence.id;
        if (alias === "validator.test") return `attempt-${attempt}.validator.json`;
        return alias;
      };
      finalValidation.checks = finalValidation.checks.map((item) => ({ ...item, evidence_refs: item.evidence_refs.map(evidenceIdFor) }));
      const validatorEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.validator.json`), `${canonicalJson({ schema_version: "howa.ddv1-validator-result.v2", run_id: options.run_id, trial_id: trialId, attempt, fixture_digest: fixture.authority.fixture_digest, entropy_commitment: entropy.commitment, expected_object_digest: finalValidation.expected_object_digest, authority_digest: finalValidation.authority_digest, validator_check_set_digest: finalValidation.validator_check_set_digest, consumed_expected_fields: finalValidation.consumed_expected_fields, validator_check_ids: finalValidation.validator_check_ids, checks: finalValidation.checks, raw_verdict: finalValidation.raw_verdict, accepted: finalValidation.accepted, disqualifier_codes: finalValidation.disqualifier_codes })}\n`);
      evidence.push(validatorEvidence);
      if (!finalValidation.accepted && correctionRounds < maxCorrections) { correctionRounds += 1; continue; }
      break;
    }

    const runFinishedMs = Date.now();
    const disqualifiers = new Set(finalValidation?.disqualifier_codes ?? []);
    if (secretExposure) disqualifiers.add("SECRET_EXPOSURE");
    if (usageMissing) disqualifiers.add("USAGE_REPORT_MISSING");
    if (transcriptMissing) disqualifiers.add("HERMES_TRANSCRIPT_MISSING");
    if (usageIdentityMismatch) disqualifiers.add("MODEL_PROVIDER_IDENTITY_MISMATCH");
    const rate = lookupRate(options.candidate.provider_id, options.candidate.provider_route, options.candidate.model_id);
    const apiCost = apiEquivalentCost(rate, tokensReported ? totalInputTokens : null, tokensReported ? totalOutputTokens : null);
    if (apiCost === null) disqualifiers.add("COST_UNKNOWN");
    if (typeof options.candidate.max_trial_cost_usd === "number" && (apiCost === null || apiCost > options.candidate.max_trial_cost_usd)) disqualifiers.add(apiCost === null ? "TRIAL_COST_LIMIT_UNVERIFIABLE" : "TRIAL_COST_LIMIT_EXCEEDED");
    if (!finalValidation && connectionFailures.length > 0) disqualifiers.add("TRANSPORT_FAILURE");
    let rawVerdict = secretExposure ? "FAIL" : finalValidation?.raw_verdict ?? "ERROR";
    let accepted = !secretExposure && (finalValidation?.accepted ?? false) && disqualifiers.size === 0;
    const safeArgs = authoritativeArgs.map((arg, index) => { const value=redactSecrets(arg,`hermes-argument-${index}`,secretSentinels); redactionEvents.push(...value.events); secretExposure ||= value.confirmed; return value.text; });
    if(secretExposure){disqualifiers.add("SECRET_EXPOSURE");rawVerdict="FAIL";accepted=false;}
    const configurationDigest = sha256(canonicalJson({ public_configuration: options.candidate.hermes_configuration, hermes_arguments: safeArgs, hermes_launcher_digest: runtime.launcher_digest, terminal_sandbox_digest: runtime.terminal_sandbox_digest, hermes_executable_digest: runtime.hermes_executable_digest, runtime_policy_digest: runtime.policy_digest, limits: { max_turns: options.candidate.max_turns ?? 24, max_output_tokens: options.candidate.max_output_tokens ?? 8192 }, environment_policy: "env-i/single-provider-credential/provider-only/air-gapped-terminal" }));
    const systemPromptDigest = sha256(canonicalJson({ task_prompt: prompt, prompt_implementation_digest: promptImplementationDigest, hermes_executable_digest: runtime.hermes_executable_digest }));
    const toolRegistryDigest = sha256(canonicalJson({ implementation_digest: toolImplementationDigest, enabled_toolsets: options.candidate.hermes_configuration.toolsets ?? [], permitted_trial_tools: trial.permitted_tools, terminal_sandbox_digest: runtime.terminal_sandbox_digest }));
    const evidenceBase = path.join("artifacts", options.run_id, trialId);
    evidence.push(await writeEvidence(options.output_root,path.join(evidenceBase,"trusted-authority.json"),`${canonicalJson({schema_version:AUTHORITY_SCHEMA_VERSION,suite_version:DAILY_DRIVER_SUITE_VERSION,runtime_policy_version:runtime.policy_version,run_id:options.run_id,trial_id:trialId,entropy_commitment:entropy.commitment,fixture_digest:fixtureDigest,expected_object_digest:expectedObjectDigest,validator_check_set_digest:validatorCheckSetDigest,required_sources_digest:requiredSourcesDigest,authority_digest:authorityDigest})}\n`, "artifact", 0o400));
    evidence.push(await writeEvidence(options.output_root,path.join(evidenceBase,"runtime-identity.json"),`${canonicalJson({hermes_launcher_digest:runtime.launcher_digest,terminal_sandbox_digest:runtime.terminal_sandbox_digest,hermes_executable_digest:runtime.hermes_executable_digest,runtime_policy_version:runtime.policy_version,runtime_policy_digest:runtime.policy_digest,hermes_configuration_digest:configurationDigest,system_prompt_digest:systemPromptDigest,tool_registry_digest:toolRegistryDigest,cost_rate_card_version:DAILY_DRIVER_RATE_CARD_VERSION,campaign_entropy_commitment:entropy.commitment})}\n`));
    const manifest = await buildEvidenceManifest(options.output_root,options.run_id,trialId,evidence);
    const receipt = sealReceipt({
      schema_version: DAILY_DRIVER_SCHEMA_VERSION,
      trial_id: trial.id,
      trial_suite_version: DAILY_DRIVER_SUITE_VERSION,
      run_id: options.run_id,
      timestamp: new Date(runFinishedMs).toISOString(),
      model_id: options.candidate.model_id,
      provider_id: options.candidate.provider_id,
      provider_route: options.candidate.provider_route,
      reasoning_level: options.candidate.reasoning_level,
      served_model_identity: servedModelIdentity,
      hermes_version: runtime.hermes_version,
      hermes_commit: runtime.hermes_commit,
      hermes_launcher_digest: runtime.launcher_digest,
      terminal_sandbox_digest: runtime.terminal_sandbox_digest,
      runtime_policy_version: runtime.policy_version,
      runtime_policy_digest: runtime.policy_digest,
      hermes_executable_digest: runtime.hermes_executable_digest,
      hermes_arguments: safeArgs,
      requested_temperature: options.candidate.temperature ?? null,
      hermes_configuration_digest: configurationDigest,
      system_prompt_digest: systemPromptDigest,
      tool_registry_digest: toolRegistryDigest,
      fixture_digest: fixtureDigest,
      campaign_entropy_commitment: entropy.commitment,
      expected_object_digest: expectedObjectDigest,
      authority_digest: authorityDigest,
      validator_check_set_digest: validatorCheckSetDigest,
      start_timestamp: startTimestamp,
      end_timestamp: new Date(runFinishedMs).toISOString(),
      wall_clock_duration_ms: runFinishedMs - runStartedMs,
      attempts,
      retries: Math.max(0, attempts.length - 1),
      connection_failures: connectionFailures,
      timeout_events: timeoutEvents,
      compaction_events: observedCompactions,
      input_tokens: tokensReported ? totalInputTokens : null,
      output_tokens: tokensReported ? totalOutputTokens : null,
      charged_cost_usd: null,
      api_equivalent_cost_usd: apiCost,
      plan_credit_consumed: rate?.billing === "token_plan" && tokensReported ? totalInputTokens + totalOutputTokens : null,
      subscription_quota_consumed: rate?.billing === "subscription" ? attempts.length : null,
      cost_rate_card_version: DAILY_DRIVER_RATE_CARD_VERSION,
      cost_provenance: rate?.billing === "subscription" ? "subscription" : rate?.billing === "token_plan" ? "token_plan" : apiCost === null ? "unknown" : "rate_card_estimate",
      candidate_accommodations: [...(options.candidate.candidate_accommodations ?? [])],
      max_turns: options.candidate.max_turns ?? 24,
      max_output_tokens: options.candidate.max_output_tokens ?? 8192,
      limits_enforcement: options.candidate.limits_enforcement ?? "enforced",
      tool_calls: toolCalls,
      mutation_observations: allMutations,
      deterministic_checks: finalValidation?.checks ?? [{ id: "transport.execution", passed: false, details: "No model output was available for deterministic validation", evidence_refs: evidence.filter((item) => item.kind === "stderr").map((item) => item.id) }],
      raw_verdict: rawVerdict,
      evidence_references: evidence,
      evidence_manifest_path: manifest.path,
      evidence_manifest_digest: manifest.digest,
      evidence_bundle_mode: "receipt-plus-evidence-directory",
      redaction_events: redactionEvents,
      correction_rounds: correctionRounds,
      accepted,
      disqualifier_codes: [...disqualifiers].sort(),
    });
    const receiptPath = await writeOnceReceipt(receipt, options.output_root);
    return { receipt, receipt_path: receiptPath };
  } finally {
    if (!options.keep_fixtures) await fs.rm(tempRoot, { recursive: true, force: true });
    await Promise.all(captureRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  }
}

export async function runDailyDriverSuite(options: RunDailyDriverOptions): Promise<TrialRunResult[]> {
  const ids = options.trial_ids ?? HERMES_DAILY_DRIVER_V1.trials.map((trial) => trial.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("trial_ids must not contain duplicates");
  const results: TrialRunResult[] = [];
  const campaignEntropy = options.campaign_entropy ?? createCampaignEntropy(options.run_id);
  let campaignCost = 0;
  const isCanary = ids.length > 0 && ids.length <= 3 && Array.isArray(options.candidate.canary_trial_ids) && ids.every((id) => options.candidate.canary_trial_ids!.includes(id));
  const activeCostLimit = isCanary ? options.candidate.max_canary_cost_usd : options.candidate.max_campaign_cost_usd;
  for (const id of ids) {
    if (typeof activeCostLimit === "number" && campaignCost >= activeCostLimit) throw new Error(`${isCanary ? "canary" : "campaign"} cost limit reached before ${id}`);
    const result = await runDailyDriverTrial({ ...options, campaign_entropy: campaignEntropy }, id);
    results.push(result);
    campaignCost = addKnownCampaignCost(campaignCost, result.receipt.api_equivalent_cost_usd, id);
    if (typeof activeCostLimit === "number" && campaignCost > activeCostLimit) throw new Error(`${isCanary ? "canary" : "campaign"} cost limit exceeded after ${id}; receipts remain application-write-once and tamper-evident`);
  }
  return results;
}

/** Single fail-closed path used by campaign ceilings and directly regression-tested. */
export function addKnownCampaignCost(current: number, next: number | null, trialId: string): number {
  if (next === null) throw new Error(`campaign cost cannot be enforced after ${trialId}: API-equivalent cost is unknown`);
  return current + next;
}
