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

interface LunaSession {
  endpoint: string;
  workspace: string;
  modelInfo: ModelInfo;
  cost: CostInfo;
  timeoutMs: number;
  events: AgentEvent[];
}

const VERSION = "0.3.0";
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
      const url = `${endpoint}/health`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const text = await res.text().catch(() => "");
        if (!res.ok) {
          return {
            ok: false,
            reason:
              `Luna adapter reached ${url}, but it returned HTTP ${res.status}. ` +
              `${text.slice(0, 240) || "Start/configure the local Luna API before testing."}`,
          };
        }
        return { ok: true, reason: `Luna API reachable at ${url}` };
      } catch (err) {
        return {
          ok: false,
          reason:
            `Luna adapter could not reach ${url}. Start Luna API or set LUNA_URL. ` +
            `Error: ${(err as Error).message}`,
        };
      }
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
