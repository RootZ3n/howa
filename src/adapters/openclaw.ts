import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createGenericCliAdapter } from "./generic-cli.js";
import { parseShellWords } from "./aedis.js";
import type { AgentAdapter } from "./types.js";
import type { RunOptions, SessionHandle } from "../types.js";

/**
 * OpenClaw adapter. Drives the `openclaw` CLI by default.
 * Replace the inner shell-out with the real OpenClaw SDK once it stabilizes.
 */
export function createOpenClawAdapter(): AgentAdapter {
  const inner = createGenericCliAdapter();
  return {
    ...inner,
    id: "openclaw",
    version: "0.1.0",
    name: "OpenClaw",
    description:
      "OpenClaw agent driver. Dispatches prompts via `<openclaw> agent --message <prompt>`; override with OPENCLAW_BIN or extra.command.",
    capabilities: { ...inner.capabilities, fileEditing: true, toolUse: true },
    truth: {
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: true,
    },
    protocol: {
      name: "openclaw-cli",
      submitCommand: "<openclaw> agent --message <prompt>",
      notes: [
        "Prompts are appended as the final argv element — no shell interpolation.",
        "OPENCLAW_BIN may include launcher args (e.g. \"node /path/to/cli.js\").",
        "Health probe verifies the CLI exposes `agent` and `--message` before any test runs.",
      ],
    },
    async startSession(opts: RunOptions): Promise<SessionHandle> {
      const launch = resolveOpenClawLaunch(opts);
      const extra = (opts.extra ?? {}) as Record<string, any>;
      const sessionKey = `colosseum-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerArgs = (opts.extra as { args?: string[] } | undefined)?.args;
      const dispatchArgs = callerArgs ?? [
        "agent",
        "--session-id",
        sessionKey,
        "--message",
      ];

      // Create an isolated state dir for this test session, but copy auth
      // profiles and gateway config from the main OpenClaw installation.
      const mainStateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(
        process.env.HOME ?? "/root",
        ".openclaw",
      );
      const testStateDir = path.join(
        path.dirname(opts.workspace),
        `.openclaw-state-${path.basename(opts.workspace)}`,
      );

      // Copy auth profiles + auth state + gateway config from main to test state dir
      const mainAgentDir = path.join(mainStateDir, "agents", "main", "agent");
      const testAgentDir = path.join(testStateDir, "agents", "main", "agent");
      try {
        await fs.mkdir(testAgentDir, { recursive: true });
        for (const file of ["auth-profiles.json", "auth-state.json"]) {
          const src = path.join(mainAgentDir, file);
          const dst = path.join(testAgentDir, file);
          try {
            await fs.copyFile(src, dst);
          } catch {
            // File may not exist in main — that's OK
          }
        }
        // Copy the main openclaw.json so the per-test agent has gateway config
        const mainConfig = path.join(mainStateDir, "openclaw.json");
        const testConfig = path.join(testStateDir, "openclaw.json");
        try {
          await fs.copyFile(mainConfig, testConfig);
        } catch {
          // Config may not exist — that's OK
        }
      } catch {
        // If we can't copy auth, the health probe will catch it
      }

      // Pass gateway token if available in the environment
      const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

      const merged: RunOptions = {
        ...opts,
        extra: {
          provider: "openclaw",
          location: opts.location ?? "unknown",
          ...extra,
          env: {
            OPENCLAW_STATE_DIR: testStateDir,
            ...(gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: gatewayToken } : {}),
            ...(extra.env ?? {}),
          },
          command: launch.command,
          args: [...launch.args, ...dispatchArgs],
        },
      };
      return inner.startSession(merged);
    },
    async health() {
      const launch = resolveOpenClawLaunch({});

      // ── Phase 1: Binary exists ──
      const which = spawnSync("sh", ["-c", `command -v -- ${shellQuote(launch.command)}`], {
        encoding: "utf8",
      });
      if (which.status !== 0 || !which.stdout.trim()) {
        return {
          ok: false,
          reason:
            `OpenClaw adapter could not launch: command not found "${launch.command}". ` +
            `Install the OpenClaw CLI, put it on PATH, or set OPENCLAW_BIN to ` +
            `the absolute path of your launcher (may include args, e.g. ` +
            `OPENCLAW_BIN="node /path/to/openclaw/dist/cli.js").`,
        };
      }

      // ── Phase 2: CLI structure (agent command + --message flag) ──
      const rootProbe = spawnSync(launch.command, [...launch.args, "--help"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const rootText = `${rootProbe.stdout ?? ""}\n${rootProbe.stderr ?? ""}`;
      const commandsLine = rootText.match(/Commands?:\s*([\s\S]+?)(?:\n\n|Examples:|Docs:|$)/i);
      if (!commandsLine || !/\bagent\b/.test(commandsLine[1])) {
        return {
          ok: false,
          reason:
            `OpenClaw adapter found "${launch.command}", but its help output did not ` +
            `advertise the \`agent\` command. This adapter will not run tests against ` +
            `an unknown CLI protocol.`,
        };
      }
      const agentProbe = spawnSync(launch.command, [...launch.args, "agent", "--help"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const agentText = `${agentProbe.stdout ?? ""}\n${agentProbe.stderr ?? ""}`;
      if (!agentText.includes("--message")) {
        return {
          ok: false,
          reason:
            `OpenClaw adapter found "${launch.command} agent", but the command help ` +
            `does not expose --message. Configure extra.args explicitly if your ` +
            `OpenClaw build uses a different prompt flag.`,
        };
      }

      // ── Phase 3: Deep probe — actually try running a trivial prompt ──
      // This catches auth failures, missing API keys, model unavailability,
      // and other runtime issues that a CLI structure check can't detect.
      const sessionKey = `colosseum-health-${Date.now()}`;
      const deepProbe = spawnSync(
        launch.command,
        [...launch.args, "agent", "--session-id", sessionKey, "--message", "ping"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env },
        },
      );
      const probeStderr = deepProbe.stderr ?? "";
      const probeStdout = deepProbe.stdout ?? "";
      const probeOutput = probeStdout + "\n" + probeStderr;

      if (deepProbe.status !== 0) {
        // Classify the failure for actionable guidance
        const isAuth =
          /api.?key|auth|credential|unauthorized|401|forbidden|403/i.test(probeOutput);
        const isModel =
          /model.*not.*found|provider.*not.*available|no.*model|rate.?limit|429/i.test(probeOutput);

        let reason: string;
        if (isAuth) {
          reason =
            `OpenClaw auth failed (exit ${deepProbe.status}). The CLI launched but the ` +
            `model provider rejected the request. Set the appropriate API key ` +
            `(e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY) or configure auth via ` +
            `openclaw agents add. stderr: ${probeStderr.slice(0, 300)}`;
        } else if (isModel) {
          reason =
            `OpenClaw model unavailable (exit ${deepProbe.status}). The CLI launched and ` +
            `auth may be OK, but the requested model is not available. Check model ` +
            `name, provider availability, and rate limits. stderr: ${probeStderr.slice(0, 300)}`;
        } else {
          reason =
            `OpenClaw deep probe failed (exit ${deepProbe.status}). The CLI structure ` +
            `is correct but the agent cannot run. stderr: ${probeStderr.slice(0, 300)}`;
        }

        return { ok: false, reason };
      }

      // Check for error indicators even on exit 0
      if (/failovererror|no api key/i.test(probeOutput)) {
        return {
          ok: false,
          reason:
            `OpenClaw deep probe exited 0 but reported auth issues. ` +
            `stderr: ${probeStderr.slice(0, 300)}`,
        };
      }

      return {
        ok: true,
        reason: `binary resolved to ${which.stdout.trim()}; deep probe passed (exit 0). Dispatches via ${launch.command} ${[
          ...launch.args,
          "agent",
          "--message",
          "<prompt>",
        ].join(" ")}`,
      };
    },
  };
}

export interface OpenClawLaunch {
  command: string;
  args: string[];
  source: "extra.command" | "OPENCLAW_BIN" | "default";
}

export function resolveOpenClawLaunch(opts: { extra?: unknown }): OpenClawLaunch {
  const extra = (opts.extra ?? {}) as Record<string, unknown>;
  if (typeof extra.command === "string" && extra.command) {
    return { command: extra.command, args: [], source: "extra.command" };
  }
  const bin = process.env.OPENCLAW_BIN;
  if (typeof bin === "string" && bin.trim().length > 0) {
    const tokens = parseShellWords(bin.trim());
    if (tokens.length > 0) {
      return {
        command: tokens[0],
        args: tokens.slice(1),
        source: "OPENCLAW_BIN",
      };
    }
  }
  return { command: "openclaw", args: [], source: "default" };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
