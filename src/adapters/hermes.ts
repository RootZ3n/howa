import { createGenericCliAdapter } from "./generic-cli.js";
import type { AgentAdapter } from "./types.js";
import type { RunOptions, SessionHandle } from "../types.js";

/**
 * Module-level persistent session tracker for context-stamina mode.
 * When HOWA_CONTEXT_STAMINA=true (or the pre-rename
 * COLOSSEUM_CONTEXT_STAMINA), the adapter keeps a single Hermes session
 * alive across all tests in the trial, using `--continue` for
 * subsequent invocations so context accumulates across turns.
 */
let _contextStaminaInitialized = false;

/**
 * Hermes adapter. Drives the `hermes` CLI by default.
 * Hermes is positioned for local-first inference; the default location is "local".
 *
 * Context-stamina mode (HOWA_CONTEXT_STAMINA=true):
 *   First test: `hermes chat -q "<prompt>"` — creates a real Hermes session
 *   Subsequent tests: `hermes --continue -q "<prompt>"` — resumes the same session
 *   This tests multi-turn context retention across the trial.
 */
export function createHermesAdapter(): AgentAdapter {
  const inner = createGenericCliAdapter();
  return {
    ...inner,
    id: "hermes",
    version: "0.1.0",
    name: "Hermes",
    description:
      "Hermes agent driver. Local-first by default. Wraps the `hermes` CLI; pass extra.command to override. " +
      "Set HOWA_CONTEXT_STAMINA=true to enable persistent session mode for multi-turn testing.",
    capabilities: { ...inner.capabilities, fileEditing: true, toolUse: true },
    truth: {
      modelIdentity: "unknown",
      costTruth: "unknown",
      eventStructure: "unstructured",
      toolSupport: true,
    },
    async startSession(opts: RunOptions): Promise<SessionHandle> {
      const useContextStamina =
        process.env.HOWA_CONTEXT_STAMINA === "true" ||
        process.env.COLOSSEUM_CONTEXT_STAMINA === "true" ||
        (opts.extra?.contextStamina as boolean) === true;

      const args: string[] = [];

      if (useContextStamina) {
        if (_contextStaminaInitialized) {
          // Subsequent tests: resume the persistent session.
          // -c uses nargs='?' (greedy), so we pass an empty string as the
          // session name to prevent it from consuming 'chat' as a name.
          args.push("-c", "", "chat", "-q");
        } else {
          // First test: create a new session
          args.push("chat", "-q");
          _contextStaminaInitialized = true;
        }
      } else {
        // Standard mode: fresh process per test (default)
        args.push("chat", "-q");
      }

      const merged: RunOptions = {
        ...opts,
        extra: {
          command: "hermes",
          args,
          provider: "hermes",
          location: opts.location ?? "local",
          ...(opts.extra ?? {}),
        },
      };
      return inner.startSession(merged);
    },
    async health() {
      return { ok: true, reason: "binary check deferred to first run" };
    },
  };
}