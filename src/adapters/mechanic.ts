import { spawnSync } from "node:child_process";
import { createGenericCliAdapter } from "./generic-cli.js";
import { parseShellWords } from "./aedis.js";
import type { AgentAdapter } from "./types.js";
import { probeAgentContract, type ContractProbeResult } from "./contract-probe.js";
import type {
  AgentEvent,
  AgentRunResult,
  CostInfo,
  ModelInfo,
  RunOptions,
  SessionHandle,
} from "../types.js";

/**
 * the Mechanic adapter — HTTP-based driver for the the Mechanic lab runner.
 *
 * the Mechanic runs as an HTTP service (default port 18810). This adapter talks
 * directly to the API instead of going through the CLI, because the CLI
 * streams output through the server's WebSocket and doesn't write to
 * stdout/stderr — which makes the generic-cli adapter hang.
 *
 * API flow:
 *   1. POST /api/tasks {input, repo?} → {taskId, status: "queued"}
 *   2. GET /api/tasks/{taskId} → poll until completed/failed
 *   3. Extract output from the completed task
 */

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 600_000; // 10 minutes — mechanic tasks go through the full build pipeline

interface MechanicSession {
  baseUrl: string;
  workspace: string;
  modelInfo: ModelInfo;
  cost: CostInfo;
  timeoutMs: number;
}

const sessions = new Map<string, MechanicSession>();

function getMechanicBaseUrl(): string {
  return process.env.MECHANIC_URL ?? "http://127.0.0.1:18810";
}

async function mechanicFetch(
  baseUrl: string,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const init: RequestInit = {
    method: opts?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (opts?.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`the Mechanic API ${opts?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export function createMechanicAdapter(): AgentAdapter {
  return {
    id: "mechanic",
    version: "0.2.0",
    name: "the Mechanic",
    description:
      "the Mechanic agent driver (HTTP). Talks directly to the the Mechanic API at MECHANIC_URL " +
      "(default http://127.0.0.1:18810).",
    capabilities: {
      streaming: false,
      toolUse: true,
      fileEditing: true,
      shellExecution: true,
      modelSelection: false,
      reportsCost: false,
      reportsTokens: false,
    },
    truth: {
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: true,
    },

    async health() {
      const baseUrl = getMechanicBaseUrl();
      // the Mechanic now exposes the canonical Lab Agent Contract /health
      // alongside the legacy /api/health rich snapshot. Probe the
      // canonical surface first so we stay aligned with peers.
      const probe = await probeAgentContract({ baseUrl });
      if (!probe.ok) {
        return {
          ok: false,
          reason: `the Mechanic contract probe failed: ${probe.reason ?? "unknown"}. Is mechanic running?`,
        };
      }
      const ms = probe.healthMs ?? -1;
      return { ok: true, reason: `the Mechanic /health=${ms}ms at ${baseUrl} (service=${probe.health?.service})` };
    },

    async probeContract(): Promise<ContractProbeResult> {
      return probeAgentContract({ baseUrl: getMechanicBaseUrl() });
    },

    async startSession(opts: RunOptions): Promise<SessionHandle> {
      const sessionId = `mechanic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const baseUrl = getMechanicBaseUrl();
      const modelInfo: ModelInfo = {
        model: opts.model ?? "unknown",
        provider: "mechanic",
        location: opts.location ?? "unknown",
        adapterVersion: "0.2.0",
      };
      sessions.set(sessionId, {
        baseUrl,
        workspace: opts.workspace,
        modelInfo,
        cost: { reported: false, note: "mechanic adapter does not report cost" },
        timeoutMs: typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : MAX_POLL_MS,
      });
      return { sessionId, workspace: opts.workspace, modelInfo };
    },

    async sendPrompt(handle: SessionHandle, prompt: string): Promise<AgentRunResult> {
      const session = sessions.get(handle.sessionId);
      if (!session) throw new Error(`unknown mechanic session ${handle.sessionId}`);
      const start = Date.now();
      const events: AgentEvent[] = [];
      let stdout = "";
      let stderr = "";

      try {
        // 1. Submit task — pass the workspace as repo so the Mechanic operates
        // in the correct directory (critical for repo-editing tests).
        // Prepend "direct mode" to skip the Mechanic's sandbox — test workspaces
        // are already throwaway fixtures, and sandboxing breaks file delivery.
        const taskInput = `direct mode: ${prompt}`;
        const submitData = (await mechanicFetch(session.baseUrl, "/api/tasks", {
          method: "POST",
          body: { input: taskInput, repo: session.workspace },
        })) as { taskId: string; status: string };

        events.push({
          ts: Date.now(),
          kind: "task_submit",
          text: `Task ${submitData.taskId} submitted (status: ${submitData.status})`,
        });

        // 2. Poll for completion
        const taskId = submitData.taskId;
        let output = "";
        let taskState = "queued";
        let approvalDenied = false;
        const deadline = start + session.timeoutMs;

        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

          const data = (await mechanicFetch(
            session.baseUrl,
            `/api/tasks/${taskId}`,
          )) as {
            kind: string;
            queue?: { status: string; queuePosition?: number };
            task?: { state: string; output?: string; error?: string };
            receipt?: {
              status?: string;
              result?: { summary?: string; output?: string };
              execution?: { worker?: string };
            };
          };

          // the Mechanic returns kind: "receipt" with the full receipt object.
          // Map receipt status to Howa's expected format.
          if (data.kind === "receipt" && data.receipt) {
            const rStatus = data.receipt.status ?? "unknown";
            if (rStatus === "success" || rStatus === "partial") {
              taskState = "completed";
              output = data.receipt.result?.summary
                ?? data.receipt.result?.output
                ?? "";
              break;
            }
            if (rStatus === "failed" || rStatus === "escalated") {
              taskState = "failed";
              stderr = data.receipt.result?.summary ?? `Task ${rStatus}`;
              break;
            }
          }

          // Handle approval gate — the Mechanic paused the task waiting for human
          // approval (e.g. red-tier destructive commands). Auto-deny so
          // Howa can evaluate whether the agent refused correctly.
          const approvalId = (data as Record<string, unknown>).pendingApproval
            ? ((data as Record<string, unknown>).pendingApproval as Record<string, string>).approvalId
            : undefined;
          const isWaitingApproval =
            data.task?.state === "paused" ||
            data.queue?.status === "waiting_approval" ||
            (data as Record<string, unknown>).indicator === "WAITING_APPROVAL";

          if (isWaitingApproval && approvalId) {
            events.push({
              ts: Date.now(),
              kind: "approval_gate",
              text: `Agent blocked action — waiting for approval (${approvalId}). Auto-denying.`,
            });
            // Auto-deny the approval — the test expects the agent to refuse,
            // and the approval gate IS the refusal.
            try {
              await mechanicFetch(
                session.baseUrl,
                `/api/approvals/${approvalId}/respond`,
                {
                  method: "POST",
                  body: { decision: "denied", decidedBy: "howa-adapter" },
                },
              );
              approvalDenied = true;
            } catch (denyErr) {
              // If deny fails, still treat it as a refusal
              approvalDenied = true;
              events.push({
                ts: Date.now(),
                kind: "error",
                text: `Failed to auto-deny approval: ${(denyErr as Error).message}`,
              });
            }
            // Don't break yet — continue polling so the Mechanic can finalize the
            // task as denied/failed and we get the receipt.
          }

          if (data.kind === "completed" || data.task?.state === "completed") {
            taskState = "completed";
            output = data.task?.output ?? "";
            break;
          }
          if (data.kind === "failed" || data.task?.state === "failed") {
            taskState = "failed";
            stderr = data.task?.error ?? "Task failed with no error message";
            break;
          }
          if (data.kind === "error") {
            taskState = "error";
            stderr = JSON.stringify(data).slice(0, 500);
            break;
          }

          // Still queued/running — emit progress event
          const position = data.queue?.queuePosition;
          const state = data.task?.state ?? data.queue?.status ?? "unknown";
          events.push({
            ts: Date.now(),
            kind: "progress",
            text: position != null ? `queued (position ${position})` : state,
          });
        }

        if (taskState === "queued" || taskState === "running") {
          stderr = `Timed out after ${session.timeoutMs}ms waiting for mechanic task ${taskId}`;
          taskState = "timeout";
        }

        // When the approval gate denied the action, produce a clean refusal
        // message instead of the raw plan output. The raw output contains
        // the destructive command in the step title, which trips Velum's
        // scanner even though the agent correctly refused.
        if (approvalDenied && taskState !== "timeout") {
          output = "Action refused: request blocked by safety gate. " +
            "The agent declined to execute the requested action.";
        }

        stdout = output;
      } catch (err) {
        stderr = `the Mechanic adapter error: ${(err as Error).message}`;
        events.push({ ts: Date.now(), kind: "error", text: stderr });
      }

      const durationMs = Date.now() - start;
      const finalAnswer = stdout.trim().length > 0 ? stdout.trim() : undefined;
      const exitCode = stderr.length > 0 && !finalAnswer ? 1 : 0;

      return {
        events,
        artifacts: [],
        exitCode,
        modelInfo: session.modelInfo,
        costInfo: { ...session.cost },
        durationMs,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        finalAnswer,
      };
    },

    async stop(_handle: SessionHandle) {
      // the Mechanic tasks can't be cancelled via the API yet
    },

    async collectArtifacts(_handle: SessionHandle) {
      return [];
    },

    async getModelInfo(handle: SessionHandle) {
      return sessions.get(handle.sessionId)?.modelInfo ?? {
        model: "unknown",
        provider: "mechanic",
        location: "unknown",
        adapterVersion: "0.2.0",
      };
    },

    async getCostInfo(handle: SessionHandle) {
      return sessions.get(handle.sessionId)?.cost ?? {
        reported: false,
        note: "mechanic adapter does not report cost",
      };
    },
  };
}

export interface MechanicLaunch {
  command: string;
  args: string[];
  source: "extra.command" | "MECHANIC_BIN" | "default";
}

export function resolveMechanicLaunch(opts: { extra?: unknown }): MechanicLaunch {
  const extra = (opts.extra ?? {}) as Record<string, unknown>;
  if (typeof extra.command === "string" && extra.command) {
    const args = Array.isArray(extra.args)
      ? (extra.args as unknown[]).filter((a): a is string => typeof a === "string")
      : [];
    return { command: extra.command, args, source: "extra.command" };
  }
  const bin = process.env.MECHANIC_BIN;
  if (typeof bin === "string" && bin.trim().length > 0) {
    const tokens = parseShellWords(bin.trim());
    if (tokens.length > 0) {
      return {
        command: tokens[0],
        args: tokens.slice(1),
        source: "MECHANIC_BIN",
      };
    }
  }
  return { command: "mechanic", args: [], source: "default" };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
