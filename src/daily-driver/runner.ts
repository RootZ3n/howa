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
import { createAuthoritativeFixture, observeMutations, snapshotFixture } from "./fixtures.js";
import { getDailyDriverTrial, HERMES_DAILY_DRIVER_V1, type DailyDriverTrial } from "./suite.js";
import { validateTrialResult } from "./validators.js";
import { apiEquivalentCost, DAILY_DRIVER_RATE_CARD_VERSION, lookupRate } from "./rate-card.js";

export interface DailyDriverCandidate {
  model_id: string;
  provider_id: string;
  provider_route: string;
  reasoning_level: string;
  temperature?: number;
  hermes_command: string;
  hermes_executable_path?: string;
  /** Trusted host path whose exact prompt/tool implementation files are bound into effective digests. */
  hermes_install_root?: string;
  /** No shell is used. Supported placeholders: {prompt}, {prompt_file}, {usage_file}, {workspace}, {session_root}, {trial_id}. */
  hermes_args: string[];
  hermes_version: string;
  hermes_commit: string;
  /** Public, secret-free configuration descriptor used only for a digest. */
  hermes_configuration: Record<string, unknown>;
  provider_credential_env?: "MINIMAX_API_KEY" | "MIMO_API_KEY" | "OPENAI_API_KEY" | "HOWA_OPENAI_CODEX_AUTH_BUNDLE";
  candidate_accommodations?: string[];
  /** Test-only: parent supplies known fixture interactions; forbidden for non-offline providers. */
  trusted_offline_reference?: boolean;
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
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
function redactSecrets(value: string): { text: string; found: boolean } {
  const result = redact(value);
  return { text: result.redacted, found: result.matches.length > 0 };
}

function assertCandidate(candidate: DailyDriverCandidate): void {
  for (const [key, value] of Object.entries({
    model_id: candidate.model_id, provider_id: candidate.provider_id, provider_route: candidate.provider_route,
    reasoning_level: candidate.reasoning_level, hermes_command: candidate.hermes_command,
    hermes_version: candidate.hermes_version, hermes_commit: candidate.hermes_commit,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`candidate.${key} is required`);
  }
  if (!Array.isArray(candidate.hermes_args) || candidate.hermes_args.some((value) => typeof value !== "string")) throw new Error("candidate.hermes_args must be a string array");
  if (candidate.require_usage_file === true && !candidate.hermes_args.some((value) => value.includes("{usage_file}"))) throw new Error("candidate.require_usage_file requires a {usage_file} argument placeholder");
  for (const [key, value] of Object.entries({ max_trial_cost_usd: candidate.max_trial_cost_usd, max_campaign_cost_usd: candidate.max_campaign_cost_usd, max_canary_cost_usd: candidate.max_canary_cost_usd })) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`candidate.${key} must be a positive finite number`);
  }
  const serialized = canonicalJson(candidate.hermes_configuration);
  if (redactSecrets(serialized).found) throw new Error("candidate.hermes_configuration must not contain credentials or secrets");
  if (candidate.provider_id !== "offline" && !candidate.provider_credential_env) throw new Error("candidate.provider_credential_env binds the single allowed provider credential");
  const credentialByProvider: Record<string, DailyDriverCandidate["provider_credential_env"]> = { minimax: "MINIMAX_API_KEY", xiaomi: "MIMO_API_KEY", "openai-codex": "HOWA_OPENAI_CODEX_AUTH_BUNDLE" };
  if (candidate.provider_id !== "offline" && credentialByProvider[candidate.provider_id] !== candidate.provider_credential_env) throw new Error(`candidate.provider_credential_env does not match provider ${candidate.provider_id}`);
  if (candidate.provider_id !== "offline" && !candidate.hermes_executable_path) throw new Error("candidate.hermes_executable_path is required to bind the actual Hermes executable separately from its launcher");
  if (candidate.provider_id !== "offline" && !candidate.hermes_install_root) throw new Error("candidate.hermes_install_root is required to bind the effective prompt and tool registry implementations");
  if (candidate.max_turns !== undefined && (!Number.isInteger(candidate.max_turns) || candidate.max_turns < 1)) throw new Error("candidate.max_turns must be a positive integer");
  if (candidate.max_output_tokens !== undefined && (!Number.isInteger(candidate.max_output_tokens) || candidate.max_output_tokens < 1)) throw new Error("candidate.max_output_tokens must be a positive integer");
  if (candidate.canary_trial_ids && (new Set(candidate.canary_trial_ids).size !== candidate.canary_trial_ids.length || candidate.canary_trial_ids.length !== 3 || candidate.canary_trial_ids.some((id) => !HERMES_DAILY_DRIVER_V1.trials.some((trial) => trial.id === id)))) throw new Error("candidate.canary_trial_ids must contain exactly three unique suite trials");
  if (candidate.trusted_offline_reference && candidate.provider_id !== "offline") throw new Error("trusted_offline_reference is restricted to the offline self-test provider");
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

function trustedChildEnv(candidate: DailyDriverCandidate, cwd: string, captureRoot: string, attempt: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/home/zen/.local/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOWA_DAILY_DRIVER: "1", HOWA_DAILY_DRIVER_WORKSPACE: cwd, HOWA_DAILY_DRIVER_CAPTURE_ROOT: captureRoot,
    HOWA_ATTEMPT: String(attempt), GIT_OPTIONAL_LOCKS: "0", HERMES_HOME: captureRoot,
    HERMES_SESSION_DIR: captureRoot, HERMES_STATE_DIR: captureRoot, XDG_CACHE_HOME: path.join(captureRoot, "cache"),
    XDG_CONFIG_HOME: path.join(captureRoot, "config"), XDG_DATA_HOME: path.join(captureRoot, "data"), TMPDIR: path.join(captureRoot, "tmp"),
    HOWA_MAX_TURNS: String(candidate.max_turns ?? 24), HOWA_MAX_OUTPUT_TOKENS: String(candidate.max_output_tokens ?? 8192),
  };
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

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, captureRoot: string, candidate?: DailyDriverCandidate, attempt = 1): Promise<ProcessResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: candidate ? trustedChildEnv(candidate, cwd, captureRoot, attempt) : { PATH: "/usr/bin:/bin", HOME: captureRoot, LANG: "C.UTF-8" },
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\nHowa: candidate timeout after ${timeoutMs}ms`;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      hardKill.unref();
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8").slice(0, MAX_CAPTURE_BYTES - stdout.length); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_CAPTURE_BYTES - stderr.length); });
    child.once("error", (error) => { stderr += `\nHowa spawn error: ${error.message}`; finish(127); });
    child.once("close", (code) => finish(timedOut ? 124 : code));
  });
  const finished = Date.now();
  return { stdout, stderr, exitCode, timedOut, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started };
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

async function executableDigest(command: string): Promise<string> {
  const resolved = command.includes(path.sep) ? await fs.realpath(command) : await fs.realpath(`/usr/bin/${command}`);
  return sha256(await fs.readFile(resolved));
}

async function runtimeComponentDigest(candidate: DailyDriverCandidate, relativePaths: string[], fallback: unknown): Promise<string> {
  if (!candidate.hermes_install_root) return sha256(canonicalJson(fallback));
  const components: Array<{ path: string; digest: string }> = [];
  for (const relative of relativePaths) {
    const target = path.resolve(candidate.hermes_install_root, relative);
    const root = `${path.resolve(candidate.hermes_install_root)}${path.sep}`;
    if (!target.startsWith(root)) throw new Error(`Hermes runtime component escapes install root: ${relative}`);
    components.push({ path: relative, digest: sha256(await fs.readFile(target)) });
  }
  return sha256(canonicalJson(components));
}

async function writeEvidence(outputRoot: string, relative: string, content: string): Promise<EvidenceReference> {
  const target = path.join(outputRoot, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o444);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
  const name = path.basename(relative);
  const kind: EvidenceReference["kind"] = name.includes("stdout") ? "stdout" : name.includes("stderr") ? "stderr" : name.includes("fixture") ? "fixture" : name.includes("validator") ? "validator" : "artifact";
  return { id: name.replace(/[^a-z0-9_.-]/gi, "_"), kind, path: relative.split(path.sep).join("/"), digest: sha256(content) };
}

function prefixMutations(attempt: number, values: MutationObservation[]): MutationObservation[] {
  return values.map((item) => ({ ...item, path: `attempt-${attempt}/${item.path}` }));
}

export async function runDailyDriverTrial(options: RunDailyDriverOptions, trialId: string): Promise<TrialRunResult> {
  assertCandidate(options.candidate);
  if (!/^[A-Za-z0-9_.-]+$/.test(options.run_id)) throw new Error("run_id must contain only letters, digits, dot, underscore, and hyphen");
  const trial = getDailyDriverTrial(trialId);
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
  let finalValidation: Awaited<ReturnType<typeof validateTrialResult>> | null = null;
  let secretExposure = false;
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
  const launcherHash = await executableDigest(options.candidate.hermes_command);
  const executableHash = await executableDigest(options.candidate.hermes_executable_path ?? options.candidate.hermes_command);
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
      const fixture = await createAuthoritativeFixture(workspace, trialId);
      const before = fixture.snapshot;
      if (!fixtureDigest) fixtureDigest = before.digest;
      else if (fixtureDigest !== before.digest) throw new Error(`fixture ${trialId} is not deterministic across attempts`);
      const args = substituteArgs(options.candidate.hermes_args, { prompt, prompt_file: promptFile, usage_file: usageFile, workspace, session_root: sessionRoot, trial_id: trialId });
      if (authoritativeArgs.length === 0) authoritativeArgs = args;
      const processResult = await runProcess(options.candidate.hermes_command, args, workspace, trial.timeout_ms, sessionRoot, options.candidate, attempt);
      const usage = await readUsage(usageFile);
      if (!usage) {
        usageMissing ||= options.candidate.require_usage_file === true;
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
      const transcript = await captureHermesTranscript(sessionRoot);
      transcriptMissing ||= transcript === null && options.candidate.require_transcript === true;
      const telemetry = transcript ? transcriptTelemetry(transcript, attempt) : options.candidate.trusted_offline_reference
        ? { paths: fixture.authority.required_sources.map((value) => value.startsWith("git:") ? `git ${value.slice(4)}` : value.startsWith("exec:") ? value.slice(5) : value), tools: fixture.authority.required_sources.map((value, index) => ({ attempt, sequence: index + 1, name: "offline.reference_interaction", arguments_digest: sha256(canonicalJson({ value })), started_at: processResult.startedAt, finished_at: processResult.finishedAt, exit_code: 0, timed_out: false })) }
        : { paths: [], tools: [] };
      if (transcript?.some((row) => row.compacted === 1)) {
        const compacted = transcript.filter((row) => row.compacted === 1);
        const timestamp = Math.max(...compacted.map((row) => Number(row.timestamp)).filter(Number.isFinite));
        const tokens = compacted.map((row) => row.token_count).filter((value): value is number => typeof value === "number").reduce((sum, value) => sum + value, 0);
        observedCompactions.push({ attempt, timestamp: Number.isFinite(timestamp) ? new Date(timestamp * 1_000).toISOString() : processResult.finishedAt, before_tokens: tokens || null, after_tokens: null });
      }
      toolCalls.push(...telemetry.tools);
      const transport = classifyTransport(processResult);
      const stdoutRedacted = redactSecrets(processResult.stdout);
      const stderrRedacted = redactSecrets(processResult.stderr);
      secretExposure ||= stdoutRedacted.found || stderrRedacted.found;
      const evidenceBase = path.join("artifacts", options.run_id, trialId);
      const stdoutEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.stdout.txt`), stdoutRedacted.text);
      const stderrEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.stderr.txt`), stderrRedacted.text);
      evidence.push(stdoutEvidence, stderrEvidence);
      evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.fixture-before.json`), `${canonicalJson(before)}\n`));
      evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.fixture-after.json`), `${canonicalJson(after)}\n`));
      if (usage) evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-usage.json`), `${canonicalJson(usage)}\n`));
      if (transcript) {
        const sanitized = redactSecrets(`${canonicalJson(transcript)}\n`);
        secretExposure ||= sanitized.found;
        evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-transcript.json`), sanitized.text));
      } else {
        evidence.push(await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.hermes-transcript.json`), `${canonicalJson({ available: false, reason: "isolated Hermes state.db unavailable" })}\n`));
      }
      const outcome: AttemptRecord["outcome"] = processResult.timedOut ? "timeout" : transport.transport ? "transport_failure" : processResult.exitCode === 0 ? "accepted_output" : "model_failure";
      attempts.push({ attempt, started_at: processResult.startedAt, finished_at: processResult.finishedAt, duration_ms: processResult.durationMs, exit_code: processResult.exitCode, outcome, error_kind: transport.kind, retryable: transport.retryable, stdout_digest: stdoutEvidence.digest, stderr_digest: stderrEvidence.digest });
      if (transport.transport) {
        connectionFailures.push({ attempt, kind: transport.kind ?? "UNKNOWN", timestamp: processResult.finishedAt, message: `candidate attempt ${attempt} ended with ${transport.kind ?? "transport failure"}` });
        if (processResult.timedOut) timeoutEvents.push({ attempt, timestamp: processResult.finishedAt, timeout_ms: trial.timeout_ms, phase: "candidate_process" });
        if (transport.retryable && attempts.filter((item) => item.outcome === "transport_failure" || item.outcome === "timeout").length < maxAttempts) continue;
        break;
      }
      finalValidation = await validateTrialResult({ trial, workspace, stdout: processResult.stdout, mutations, observed_tool_paths: telemetry.paths, authority: fixture.authority });
      attempts[attempts.length - 1]!.outcome = finalValidation.accepted ? "accepted_output" : "model_failure";
      attempts[attempts.length - 1]!.error_kind = finalValidation.accepted ? null : "MODEL_OUTPUT_REJECTED";
      attempts[attempts.length - 1]!.retryable = !finalValidation.accepted && correctionRounds < maxCorrections;
      const validatorEvidence = await writeEvidence(options.output_root, path.join(evidenceBase, `attempt-${attempt}.validator.json`), `${canonicalJson({ checks: finalValidation.checks, raw_verdict: finalValidation.raw_verdict, accepted: finalValidation.accepted, disqualifier_codes: finalValidation.disqualifier_codes })}\n`);
      evidence.push(validatorEvidence);
      const evidenceIdFor = (alias: string): string => {
        if (alias === "candidate.stdout") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.stdout.txt`))?.id ?? alias;
        if (alias === "fixture.before") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.fixture-before.json`))?.id ?? alias;
        if (alias === "fixture.after") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.fixture-after.json`))?.id ?? alias;
        if (alias === "hermes.transcript") return evidence.find((item) => item.path.endsWith(`attempt-${attempt}.hermes-transcript.json`))?.id ?? alias;
        if (alias === "validator.test") return validatorEvidence.id;
        return alias;
      };
      finalValidation.checks = finalValidation.checks.map((item) => ({ ...item, evidence_refs: item.evidence_refs.map(evidenceIdFor) }));
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
    const rawVerdict = secretExposure ? "FAIL" : finalValidation?.raw_verdict ?? "ERROR";
    const accepted = !secretExposure && (finalValidation?.accepted ?? false) && disqualifiers.size === 0;
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
      hermes_version: options.candidate.hermes_version,
      hermes_commit: options.candidate.hermes_commit,
      hermes_launcher_digest: launcherHash,
      hermes_executable_digest: executableHash,
      hermes_arguments: authoritativeArgs.map((arg) => redactSecrets(arg).text),
      requested_temperature: options.candidate.temperature ?? null,
      hermes_configuration_digest: sha256(canonicalJson({
        public_configuration: options.candidate.hermes_configuration,
        hermes_arguments: authoritativeArgs.map((arg) => redactSecrets(arg).text),
        hermes_launcher_digest: launcherHash,
        hermes_executable_digest: executableHash,
        terminal_sandbox_digest: launcherHash,
        limits: { max_turns: options.candidate.max_turns ?? 24, max_output_tokens: options.candidate.max_output_tokens ?? 8192 },
        environment_policy: "env-i/single-provider-credential/provider-only/no-terminal-credential",
      })),
      system_prompt_digest: sha256(canonicalJson({ task_prompt: prompt, prompt_implementation_digest: promptImplementationDigest, hermes_executable_digest: executableHash })),
      tool_registry_digest: sha256(canonicalJson({ implementation_digest: toolImplementationDigest, enabled_toolsets: options.candidate.hermes_configuration.toolsets ?? [], permitted_trial_tools: trial.permitted_tools })),
      fixture_digest: fixtureDigest,
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
      candidate_accommodations: [...(options.candidate.candidate_accommodations ?? []), ...(options.candidate.trusted_offline_reference ? ["trusted offline reference interaction manifest (self-test only)"] : [])],
      max_turns: options.candidate.max_turns ?? 24,
      max_output_tokens: options.candidate.max_output_tokens ?? 8192,
      limits_enforcement: options.candidate.limits_enforcement ?? "enforced",
      tool_calls: toolCalls,
      mutation_observations: allMutations,
      deterministic_checks: finalValidation?.checks ?? [{ id: "transport.execution", passed: false, details: "No model output was available for deterministic validation", evidence_refs: evidence.filter((item) => item.kind === "stderr").map((item) => item.id) }],
      raw_verdict: rawVerdict,
      evidence_references: evidence,
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
  let campaignCost = 0;
  const isCanary = ids.length > 0 && ids.length <= 3 && Array.isArray(options.candidate.canary_trial_ids) && ids.every((id) => options.candidate.canary_trial_ids!.includes(id));
  const activeCostLimit = isCanary ? options.candidate.max_canary_cost_usd : options.candidate.max_campaign_cost_usd;
  for (const id of ids) {
    if (typeof activeCostLimit === "number" && campaignCost >= activeCostLimit) throw new Error(`${isCanary ? "canary" : "campaign"} cost limit reached before ${id}`);
    const result = await runDailyDriverTrial(options, id);
    results.push(result);
    if (result.receipt.api_equivalent_cost_usd === null) throw new Error(`campaign cost cannot be enforced after ${id}: API-equivalent cost is unknown`);
    campaignCost += result.receipt.api_equivalent_cost_usd;
    if (typeof activeCostLimit === "number" && campaignCost > activeCostLimit) throw new Error(`${isCanary ? "canary" : "campaign"} cost limit exceeded after ${id}; receipts remain application-write-once and tamper-evident`);
  }
  return results;
}
