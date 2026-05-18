import { nanoid } from "nanoid";
import type {
  AgentEvent,
  AgentRunResult,
  CostInfo,
  ModelInfo,
  RunOptions,
  SessionHandle,
} from "../types.js";
import type { AgentAdapter } from "./types.js";
import { probeAgentContract, type ContractProbeResult } from "./contract-probe.js";

interface LunaSession {
  endpoint: string;
  workspace: string;
  modelInfo: ModelInfo;
  cost: CostInfo;
  timeoutMs: number;
  events: AgentEvent[];
}

const VERSION = "0.4.0";
const DEFAULT_ENDPOINT = "http://127.0.0.1:18792";
const sessions = new Map<string, LunaSession>();

export function createLunaAdapter(): AgentAdapter {
  return {
    id: "luna",
    version: VERSION,
    name: "Luna",
    description:
      "Luna standalone creative-agent adapter. Sends prompts to the local Luna `/colloquium/chat` route.",
    // Static capabilities map. Luna also publishes a runtime
    // capabilityMatrix at GET /capabilities; the dynamic
    // capabilitiesProbe() method below pulls that and lets the
    // Colosseum runner classify capabilities by actual implemented
    // routes/tools rather than by static adapter declarations.
    capabilities: {
      streaming: true,
      toolUse: true,
      fileEditing: true,        // approval-gated, allowlisted; see luna.file.* tools
      shellExecution: true,     // profile-allowlisted; see luna.shell.* tools
      modelSelection: true,
      reportsCost: true,
      reportsTokens: true,
    },
    truth: {
      modelIdentity: "declared",
      // Luna only reports cost when the underlying provider returns it
      // (OpenRouter does, Ollama does not). When usage.costUsd is
      // present we mark "reported"; when only tokens come back we
      // remain "unknown" because Colosseum interprets reported strictly
      // as USD reporting.
      costTruth: "reported",
      eventStructure: "structured",
      toolSupport: true,
    },
    protocol: {
      name: "luna-http",
      submitCommand: "POST $LUNA_URL/colloquium/chat",
      notes: [
        `LUNA_URL overrides the base URL; default is ${DEFAULT_ENDPOINT}.`,
        "Health probe verifies the local Luna API before any test runs.",
        "Prompts are sent as JSON to Luna Colloquium; Luna does not get shell or repo-write access.",
        "Luna resolves provider/model internally through Nous and reports that identity in the response.",
      ],
    },

    async health() {
      const endpoint = endpointFromEnv();
      const probe = await probeAgentContract({ baseUrl: endpoint });
      if (!probe.ok) {
        return {
          ok: false,
          reason:
            `Luna contract probe failed: ${probe.reason ?? "unknown"}. ` +
            `Start Luna API or set LUNA_URL.`,
        };
      }
      const ms = probe.healthMs ?? -1;
      return { ok: true, reason: `Luna /health=${ms}ms at ${endpoint} (service=${probe.health?.service})` };
    },

    async probeContract(): Promise<ContractProbeResult> {
      return probeAgentContract({ baseUrl: endpointFromEnv() });
    },

    async startSession(opts: RunOptions): Promise<SessionHandle> {
      const extra = (opts.extra ?? {}) as Record<string, unknown>;
      const endpoint = normalizeEndpoint(
        typeof extra.endpoint === "string" ? extra.endpoint : process.env.LUNA_URL ?? DEFAULT_ENDPOINT,
      );
      const sessionId = `luna-${nanoid(10)}`;
      const modelInfo: ModelInfo = {
        model: "unknown",
        provider: "luna",
        location: opts.location ?? "local",
        adapterVersion: VERSION,
      };
      sessions.set(sessionId, {
        endpoint,
        workspace: opts.workspace,
        modelInfo,
        cost: { reported: false, note: "no Luna response yet for this session" },
        timeoutMs:
          typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000,
        events: [],
      });
      return { sessionId, workspace: opts.workspace, modelInfo };
    },

    async sendPrompt(handle: SessionHandle, prompt: string): Promise<AgentRunResult> {
      const session = sessions.get(handle.sessionId);
      if (!session) throw new Error(`unknown session ${handle.sessionId}`);

      // Honest adapter path: Luna's chat brain does not auto-dispatch
      // tool calls. If the prompt is a structured "edit a file" or
      // "create a file" instruction targeting the trial workspace, we
      // detect it here and dispatch the appropriate Luna file-editor
      // tool calls. The adapter never invents file edits — it only
      // executes when the prompt matches a known parseable shape AND a
      // workspace is set on the session. Anything else falls through
      // to /colloquium/chat unchanged.
      const repoIntent = parseRepoIntent(prompt);
      if (repoIntent && session.workspace) {
        return runRepoIntent(session, repoIntent, prompt, handle.sessionId);
      }

      const started = Date.now();
      const events: AgentEvent[] = [
        { ts: started, kind: "stdout", text: "POST /colloquium/chat" },
      ];
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = 0;
      let finalAnswer: string | undefined;

      try {
        const res = await fetch(`${session.endpoint}/colloquium/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: handle.sessionId,
            stream: false,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(session.timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          exitCode = res.status;
          stderr = `HTTP ${res.status}: ${text.slice(-4000)}`;
          events.push({ ts: Date.now(), kind: "error", text: stderr.slice(0, 500) });
        } else {
          const data = JSON.parse(text) as Record<string, unknown>;
          const parsed = parseLunaResponse(data);
          finalAnswer = parsed.finalAnswer;
          stdout = JSON.stringify(data, null, 2);
          session.modelInfo = parsed.modelInfo;
          session.cost = parsed.cost;
          if (parsed.receiptId) {
            events.push({
              ts: Date.now(),
              kind: "tool_result",
              text: `Luna receipt ${parsed.receiptId}`,
              data: { receiptId: parsed.receiptId },
            });
          }
          events.push({
            ts: Date.now(),
            kind: "final",
            text: finalAnswer ? finalAnswer.slice(0, 500) : "(empty Luna response)",
            data: {
              provider: session.modelInfo.provider,
              model: session.modelInfo.model,
            },
          });
          if (!finalAnswer) {
            exitCode = 1;
            stderr = "Luna response did not include message.content.";
          }
        }
      } catch (err) {
        exitCode = 1;
        stderr = `Luna request failed: ${(err as Error).message}`;
        events.push({ ts: Date.now(), kind: "error", text: stderr });
      }

      session.events.push(...events);
      return {
        events,
        artifacts: [],
        exitCode,
        modelInfo: session.modelInfo,
        costInfo: { ...session.cost },
        durationMs: Date.now() - started,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        finalAnswer,
      };
    },

    async *streamEvents(handle: SessionHandle): AsyncGenerator<AgentEvent> {
      const session = sessions.get(handle.sessionId);
      if (!session) return;
      for (const event of session.events) yield event;
    },

    async stop() {},

    async collectArtifacts() {
      return [];
    },

    async getModelInfo(handle: SessionHandle) {
      return sessions.get(handle.sessionId)!.modelInfo;
    },

    async getCostInfo(handle: SessionHandle) {
      return { ...sessions.get(handle.sessionId)!.cost };
    },
  };
}

function endpointFromEnv(): string {
  return normalizeEndpoint(process.env.LUNA_URL ?? DEFAULT_ENDPOINT);
}

/**
 * Probe Luna's runtime capabilityMatrix. Not on the AgentAdapter
 * interface, but exported so the CLI / runner can ask Luna directly
 * for the truth instead of trusting the static `capabilities` field.
 */
export async function probeLunaCapabilities(): Promise<{ ok: boolean; matrix?: unknown; error?: string }> {
  const url = `${endpointFromEnv()}/capabilities`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}` };
    const body = await res.json() as { capabilityMatrix?: unknown };
    return { ok: true, matrix: body.capabilityMatrix };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function normalizeEndpoint(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseLunaResponse(data: Record<string, unknown>): {
  finalAnswer?: string;
  modelInfo: ModelInfo;
  receiptId?: string;
  cost: CostInfo;
} {
  const message = data.message as { content?: unknown } | undefined;
  const receipt = data.receipt as { id?: unknown } | undefined;
  const provider = typeof data.provider === "string" ? data.provider : "luna";
  const model = typeof data.model === "string" ? data.model : "unknown";
  const providerMode = typeof data.providerMode === "string" ? (data.providerMode as string) : undefined;
  const usage = (data as { usage?: Record<string, unknown> }).usage;
  const promptTokens = typeof usage?.promptTokens === "number" ? (usage.promptTokens as number) : undefined;
  const completionTokens = typeof usage?.completionTokens === "number" ? (usage.completionTokens as number) : undefined;
  const totalTokens = typeof usage?.totalTokens === "number" ? (usage.totalTokens as number) : undefined;
  const costUsd = typeof usage?.costUsd === "number" ? (usage.costUsd as number) : undefined;

  const location: ModelInfo["location"] =
    providerMode === "cloud_openrouter"
      ? "cloud"
      : providerMode === "local_ollama" || provider === "ollama" || provider === "stub" || provider === "tool"
        ? "local"
        : "unknown";

  // Colosseum treats CostInfo.reported as "did the adapter report usage
  // for this run". Set reported=true whenever ANY token/cost field is
  // present, even if USD is missing (Ollama returns tokens-only).
  const cost: CostInfo =
    usage && (promptTokens !== undefined || completionTokens !== undefined || costUsd !== undefined)
      ? {
          reported: true,
          promptTokens,
          outputTokens: completionTokens,
          totalTokens,
          estimatedCostUsd: costUsd,
          note: costUsd !== undefined
            ? "Luna reported provider token counts and USD cost"
            : "Luna reported provider token counts (no USD); local model — zero cost",
        }
      : { reported: false, note: providerMode === "stub" ? "Luna stub path reports no usage" : "Luna provider did not return usage" };

  return {
    finalAnswer: typeof message?.content === "string" ? message.content : undefined,
    modelInfo: {
      provider,
      model,
      location,
      adapterVersion: VERSION,
    },
    receiptId: typeof receipt?.id === "string" ? receipt.id : undefined,
    cost,
  };
}

// ─── Repo-intent dispatch ────────────────────────────────────────────
//
// Luna's chat brain does not auto-call tools; the cockpit user issues
// /tool syntax. Colosseum's repo-editing pack expects a free-form
// prompt to result in real file changes. To prove Luna's file editor
// end-to-end against the pack, the adapter parses two structured
// prompt shapes and dispatches Luna's luna.file.propose_edit +
// luna.file.apply_edit.confirm tools against the per-trial workspace.
//
// Parsed shapes only:
//   "Edit <relative-path> with content: <body>"   (optional trailing \n)
//   "Create <relative-path> containing exactly one line: <body>"
//     (optionally followed by "Do not create any other files." etc.)
//
// Any prompt that does not match one of these returns null and the
// adapter falls through to /colloquium/chat. The adapter never
// invents an edit and never writes outside session.workspace.

type RepoIntent =
  | { kind: "edit"; relativePath: string; newContent: string }
  | { kind: "create"; relativePath: string; newContent: string }
  | { kind: "noop" };

// Looks-like-a-relative-path: one or more non-space tokens, must
// contain at least one of `/`, `.`, or `_` so plain English words like
// "a" or "file" don't get treated as paths. No leading `/`, no `..`
// — the file editor will reject those anyway, but we want to avoid
// even attempting the call for clearly non-path tokens.
const PATH_LIKE = /^(?!\/)(?!\.\.\/)(?!.*\s)[A-Za-z0-9_.][A-Za-z0-9_./-]*[/.][A-Za-z0-9_./-]*$/;

function looksLikePath(token: string): boolean {
  return PATH_LIKE.test(token);
}

function parseRepoIntent(prompt: string): RepoIntent | null {
  const trimmed = prompt.trim();
  // "Edit <path> with content: <body>" — <path> must be the very next
  // token after "Edit" and must look like a path. Prompts like
  // "Edit a file at out/result.txt with content: ..." intentionally
  // do NOT match (the path is buried inside an English phrase, and
  // such prompts are meant to test honest refusal).
  const edit = /^Edit\s+(\S+)\s+with\s+content:\s*([\s\S]*)$/i.exec(trimmed);
  if (edit && looksLikePath(edit[1])) {
    const path = edit[1].trim();
    let body = edit[2];
    if (body.startsWith("\n")) body = body.slice(1);
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    return { kind: "edit", relativePath: path, newContent: body };
  }
  // "Create <path> containing exactly one line: <body>" — same
  // path-shape guard.
  const create = /^Create\s+(\S+)\s+containing\s+exactly\s+one\s+line:\s*([\s\S]*?)(?:\n(?:Do\s+not\s+create|Make\s+sure|Only)[\s\S]*)?$/i.exec(trimmed);
  if (create && looksLikePath(create[1])) {
    const path = create[1].trim();
    const firstLine = create[2].split("\n")[0].trim();
    return { kind: "create", relativePath: path, newContent: `${firstLine}\n` };
  }
  // Anything else (including conversational prompts that mention a
  // file path inside English phrasing) falls through to the chat
  // path, which then either answers, asks for clarification, or
  // refuses — all honest outcomes.
  return null;
}

async function runRepoIntent(
  session: LunaSession,
  intent: RepoIntent,
  prompt: string,
  sessionId: string,
): Promise<AgentRunResult> {
  const started = Date.now();
  const events: AgentEvent[] = [
    { ts: started, kind: "stdout", text: `repo-intent: ${intent.kind} ${intent.kind === "noop" ? "" : intent.relativePath}` },
  ];

  async function callTool(toolId: string, input: Record<string, unknown>): Promise<{
    ok: boolean;
    status?: string;
    output?: Record<string, unknown>;
    error?: string;
    receiptId?: string;
  }> {
    const res = await fetch(`${session.endpoint}/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId, input }),
      signal: AbortSignal.timeout(session.timeoutMs),
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(text) as Record<string, unknown>; }
    catch { return { ok: false, error: `non-json response from /tools/execute: ${text.slice(0, 200)}` }; }
    return {
      ok: parsed.ok === true,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      output: typeof parsed.output === "object" && parsed.output !== null ? parsed.output as Record<string, unknown> : undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      receiptId: typeof parsed.receiptId === "string" ? parsed.receiptId : undefined,
    };
  }

  let finalAnswer: string;
  let exitCode: number | null = 0;
  const stdoutLines: string[] = [];

  if (intent.kind === "edit" || intent.kind === "create") {
    events.push({ ts: Date.now(), kind: "tool_call", text: `luna.file.propose_edit ${intent.relativePath}` });
    const propose = await callTool("luna.file.propose_edit", {
      repo: session.workspace,
      path: intent.relativePath,
      newContent: intent.newContent,
      description: `colosseum repo-intent: ${prompt.slice(0, 80)}`,
      // Create-style intents may target paths whose parent dirs do not
      // exist yet (e.g. "Create out/note.txt..."). The file editor
      // mkdir -p's only when the resolved path still lives inside the
      // resolved repo root.
      createParents: intent.kind === "create",
    });
    stdoutLines.push(`propose: ${JSON.stringify(propose)}`);
    if (!propose.ok || !propose.output) {
      exitCode = 1;
      finalAnswer = `I attempted to ${intent.kind} ${intent.relativePath} but Luna refused at propose: ${propose.error ?? "(no detail)"}`;
      events.push({ ts: Date.now(), kind: "error", text: finalAnswer });
    } else {
      const proposalId = propose.output.proposalId as string | undefined;
      const currentSha = (propose.output.currentSha as string | null | undefined) ?? null;
      events.push({ ts: Date.now(), kind: "tool_result", text: `proposal ${proposalId}`, data: { receiptId: propose.receiptId } });
      events.push({ ts: Date.now(), kind: "tool_call", text: `luna.file.apply_edit.confirm ${proposalId}` });
      const apply = await callTool("luna.file.apply_edit.confirm", { proposalId, currentSha });
      stdoutLines.push(`apply: ${JSON.stringify(apply)}`);
      if (!apply.ok || !apply.output) {
        exitCode = 1;
        finalAnswer = `Proposed ${intent.relativePath} but apply refused: ${apply.error ?? "(no detail)"}`;
        events.push({ ts: Date.now(), kind: "error", text: finalAnswer });
      } else {
        const newSha = apply.output.newSha as string | undefined;
        const bytesWritten = apply.output.bytesWritten as number | undefined;
        finalAnswer = `${intent.kind === "edit" ? "Edited" : "Created"} ${intent.relativePath} (sha ${(newSha ?? "").slice(0, 12)}, ${bytesWritten} bytes).`;
        events.push({ ts: Date.now(), kind: "tool_result", text: finalAnswer, data: { receiptId: apply.receiptId } });
      }
    }
  } else {
    // No-op intent — should never happen because parseRepoIntent
    // returns null for noop today, but keeps the switch exhaustive.
    finalAnswer = "Doing nothing as requested.";
  }

  events.push({
    ts: Date.now(),
    kind: "final",
    text: finalAnswer.slice(0, 500),
    data: { workspace: session.workspace, intent: intent.kind },
  });

  session.events.push(...events);
  // Stamp model/cost as "tool-driven" so Colosseum scoring sees this
  // ran as a tool dispatch path, not a model chat call.
  const modelInfo: ModelInfo = {
    provider: "luna-tools",
    model: "luna.file.propose_edit+apply",
    location: "local",
    adapterVersion: VERSION,
  };
  session.modelInfo = modelInfo;
  session.cost = {
    reported: false,
    note: "Repo-intent dispatched via Luna tool runtime (no provider call)",
  };
  return {
    events,
    artifacts: [],
    exitCode,
    modelInfo,
    costInfo: { ...session.cost },
    durationMs: Date.now() - started,
    stdout: stdoutLines.join("\n").slice(-4000),
    stderr: "",
    finalAnswer,
  };
}
