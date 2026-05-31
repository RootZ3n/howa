import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrialEvent, Verdict } from "../types.js";
import type { TrialScore } from "../scoring/score.js";
import type { AdapterTruthContract } from "../adapters/types.js";

/**
 * Filesystem layout for Howa state:
 *
 *   howa-state/
 *     trials/<trialId>.json
 *     trial-events/<trialId>.json
 *     receipts/<trialId>/<testId>.json
 *     receipts/<trialId>/<testId>.md
 *     fixtures/<trialId>/<testId>-<rand>/...     (per-test workspaces)
 *     artifacts/<trialId>/...                    (reserved)
 *     agents/                                    (reserved)
 *     reports/                                   (reserved)
 */
export interface TrialSummary {
  trialId: string;
  agentId: string;
  adapter: string;
  packs: string[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  verdict: Verdict;
  score: TrialScore;
  testCount: number;
  passCount: number;
  failCount: number;
  /** Velum aggregate decision across the whole trial. */
  velumDecision: "allow" | "warn" | "block" | "fail-test";
  /** Optional notes (e.g., model selection, location). */
  notes?: string;

  /* ------------------------------------------------------------------ */
  /*  Phase 1: truthfulness stamps                                       */
  /* ------------------------------------------------------------------ */

  /** Howa harness version at the time the trial ran. */
  howaVersion: string;
  /** Short git commit of the Howa repo. "unknown" if not in git. */
  gitCommit: string;
  /** Adapter version (declared by the adapter itself). */
  adapterVersion: string;
  /** Per-pack version map: { packId: version }. */
  packVersions: Record<string, string>;
  /** Adapter truth contract — copied onto the trial for audit. */
  adapterTruth: AdapterTruthContract;
  liveMode?: "live" | "buffered" | "replay";
  eventCount?: number;

  /* ------------------------------------------------------------------ */
  /*  Phase 2: trust honesty flags                                      */
  /* ------------------------------------------------------------------ */

  /**
   * True if this trial used the bundled mock/demo adapter. Mock results
   * MUST be visually distinguished from real-agent results in the UI and
   * leaderboards, and excluded from any "champion" surface unless mock
   * mode is explicitly opted in. Stamped here so downstream consumers
   * (UI, exports, scripts) can decide without reaching back into the
   * adapter registry.
   */
  isMockTrial?: boolean;

  /**
   * Honesty flags computed at scoring time. Convenience copy of
   * `score.honesty` — kept on the summary so list endpoints can render
   * provisional/no-evidence/all-failed chips without reading every
   * trial's score.honesty separately.
   *
   * Phase-3 fields (release hardening):
   *  - `modelUnknown`             effective truth contract still has
   *                               modelIdentity="unknown" — neither the
   *                               adapter nor the operator declared model
   *                               or provider. Receipts/UI must mark this.
   *  - `costUnknown`              effective truth contract still has
   *                               costTruth="unknown" — neither adapter
   *                               nor operator vouched for cost. Trials
   *                               in this state CANNOT participate in any
   *                               "best value" / cost-ranking surface.
   *  - `noOpExpectedPassCount`    number of receipts in this trial whose
   *                               test was marked `noOpExpected: true`
   *                               (e.g. repo.clean-on-failure). Used by
   *                               the diagnostic to make sure the only
   *                               passes a silent agent earned were on
   *                               no-op-expected tests.
   */
  honesty?: {
    provisional: boolean;
    noBehavioralEvidence: boolean;
    allBehavioralFailed: boolean;
    costExcludedFromTrust: boolean;
    noBehavioralCategories: boolean;
    behavioralN: number;
    provisionalThreshold: number;
    modelUnknown?: boolean;
    costUnknown?: boolean;
    noOpExpectedPassCount?: number;
  };

  /**
   * Schema version for the trial summary file format. Bumped whenever
   * the on-disk shape changes in a way that downstream tooling needs to
   * recognize. v2 introduces the `honesty` block and `isMockTrial` flag.
   */
  schemaVersion?: number;
}

/**
 * Current trial summary schema version. Bump when a field is added in a
 * way that older readers would silently misinterpret.
 */
export const TRIAL_SCHEMA_VERSION = 2;

export class TrialStore {
  constructor(public readonly stateRoot: string) {}

  async ensureLayout(): Promise<void> {
    for (const sub of [
      "trials",
      "receipts",
      "artifacts",
      "fixtures",
      "agents",
      "reports",
      "trial-events",
    ]) {
      await fs.mkdir(path.join(this.stateRoot, sub), { recursive: true });
    }
  }

  async saveTrial(t: TrialSummary): Promise<string> {
    await this.ensureLayout();
    const file = path.join(this.stateRoot, "trials", `${t.trialId}.json`);
    await fs.writeFile(file, JSON.stringify(t, null, 2));
    return file;
  }

  async listTrials(): Promise<TrialSummary[]> {
    await this.ensureLayout();
    const dir = path.join(this.stateRoot, "trials");
    const entries = await fs.readdir(dir).catch(() => []);
    const out: TrialSummary[] = [];
    for (const e of entries) {
      if (!e.endsWith(".json")) continue;
      const txt = await fs.readFile(path.join(dir, e), "utf8").catch(() => "");
      if (!txt) continue;
      try {
        out.push(JSON.parse(txt));
      } catch {}
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  async getTrial(id: string): Promise<TrialSummary | null> {
    const file = path.join(this.stateRoot, "trials", `${id}.json`);
    const txt = await fs.readFile(file, "utf8").catch(() => "");
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  async saveTrialEvents(trialId: string, events: TrialEvent[]): Promise<string> {
    await this.ensureLayout();
    const file = path.join(this.stateRoot, "trial-events", `${trialId}.json`);
    await fs.writeFile(file, JSON.stringify(events, null, 2));
    return file;
  }

  async getTrialEvents(trialId: string): Promise<TrialEvent[]> {
    const file = path.join(this.stateRoot, "trial-events", `${trialId}.json`);
    const txt = await fs.readFile(file, "utf8").catch(() => "");
    if (!txt) return [];
    try {
      const parsed = JSON.parse(txt);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

/**
 * Default state directory: `howa-state` (relative to cwd). Trials, receipts,
 * and bundles are written here. Deployments upgraded from the pre-rename
 * `colosseum-state` layout are migrated to this name on startup (see start.sh).
 * Override with `--state <dir>` or `HOWA_STATE_ROOT`.
 */
export function defaultStateRoot(): string {
  return path.resolve(process.cwd(), "howa-state");
}
