import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Verdict } from "../types.js";
import { logger } from "../utils/logger.js";

/**
 * Per-trial workspace lifecycle.
 *
 * Every test runs inside a freshly-created throwaway directory. The directory
 * is created under howa-state/fixtures/<trial>/<test> when a stateRoot
 * is provided, otherwise under the OS temp directory.
 *
 * Important: tested repos must NOT be dirtied. The fixture is *always* a fresh
 * copy or a fresh empty directory — the agent never operates on a real repo.
 */

/**
 * Cleanup policy for per-test workspaces:
 *   "always"  — remove every workspace at end-of-trial.
 *   "success" — remove only PASS/WARN; preserve FAIL/ERROR for evidence (DEFAULT).
 *   "never"   — preserve all workspaces.
 *
 * Receipts and trial summaries are NEVER deleted by cleanup — only fixtures.
 */
export type CleanupPolicy = "always" | "success" | "never";

export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = "success";

const PRESERVE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["fail", "error"]);

/** One stale workspace identified by the reaper. */
export interface ReapCandidate {
  /** Absolute path to the per-test workspace directory. */
  path: string;
  /** Owning trial id (the fixtures/<trialId> directory name). */
  trialId: string;
  /** How long ago the workspace was last modified, in milliseconds. */
  ageMs: number;
  /** Recursive byte size of the workspace. */
  bytes: number;
}

/**
 * Result of a reaper pass. In dry-run mode `wouldDelete`/`wouldFreeBytes`
 * describe what *would* be removed; with `dryRun: false` they describe what
 * *was* removed.
 */
export interface ReapResult {
  /** Number of workspace directories examined. */
  scanned: number;
  wouldDelete: ReapCandidate[];
  wouldFreeBytes: number;
  errors: Array<{ path: string; message: string }>;
}

/** Sum the byte size of every regular file under `dir` (recursive). */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSize(full);
    } else {
      const st = await fs.stat(full).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

export class FixtureManager {
  constructor(private readonly stateRoot: string | null) {}

  async createWorkspace(trialId: string, testId: string): Promise<string> {
    const safeTest = testId.replace(/[^a-z0-9_.-]/gi, "_");
    const base = this.stateRoot
      ? path.join(this.stateRoot, "fixtures", trialId)
      : path.join(os.tmpdir(), "howa", trialId);
    const dir = path.join(base, `${safeTest}-${nanoid(6)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async copyFixtureInto(fixtureDir: string, into: string): Promise<void> {
    await this.recursiveCopy(fixtureDir, into);
  }

  /**
   * @deprecated kept for backward compatibility — prefer applyCleanupPolicy().
   * Removes the entire trial fixture directory when stateRoot is unset.
   */
  async cleanup(trialId: string): Promise<void> {
    if (!this.stateRoot) {
      const base = path.join(os.tmpdir(), "howa", trialId);
      await fs.rm(base, { recursive: true, force: true });
    }
  }

  /**
   * Apply the configured cleanup policy. Returns a list of `{ testId, removed }`
   * records so the runner can put them on the trial summary for transparency.
   *
   * Receipts and trial summaries are never touched.
   */
  async applyCleanupPolicy(
    trialId: string,
    verdictByTestId: ReadonlyMap<string, Verdict>,
    policy: CleanupPolicy,
  ): Promise<Array<{ testId: string; removed: boolean; reason: string }>> {
    if (policy === "never") {
      return [...verdictByTestId.keys()].map((testId) => ({
        testId,
        removed: false,
        reason: "policy=never",
      }));
    }
    const base = this.stateRoot
      ? path.join(this.stateRoot, "fixtures", trialId)
      : path.join(os.tmpdir(), "howa", trialId);

    let entries: string[] = [];
    try {
      entries = await fs.readdir(base);
    } catch {
      return [];
    }

    const out: Array<{ testId: string; removed: boolean; reason: string }> = [];
    for (const dirName of entries) {
      // Workspace dir name is "<safeTestId>-<rand>"; recover the testId
      // by stripping the trailing nanoid (6 chars after the last "-").
      const testId = dirName.replace(/-[A-Za-z0-9_-]{6}$/, "");
      const verdict = verdictByTestId.get(testId);
      const shouldPreserve =
        policy === "success" && verdict !== undefined && PRESERVE_VERDICTS.has(verdict);
      if (shouldPreserve) {
        out.push({
          testId,
          removed: false,
          reason: `preserve ${verdict} fixture for evidence`,
        });
        continue;
      }
      const target = path.join(base, dirName);
      try {
        await fs.rm(target, { recursive: true, force: true });
        out.push({
          testId,
          removed: true,
          reason:
            policy === "always"
              ? "policy=always"
              : `cleanup ${verdict ?? "unknown"} per policy=success`,
        });
      } catch (err) {
        out.push({
          testId,
          removed: false,
          reason: `cleanup failed: ${(err as Error).message}`,
        });
      }
    }
    return out;
  }

  /**
   * Reap preserved per-test workspaces older than `maxAgeDays`.
   *
   * Preserved FAIL/ERROR fixtures (kept as evidence by the "success" cleanup
   * policy) otherwise live forever, growing disk without bound. This reaper
   * gives them a TTL. By default it is a DRY RUN — it computes which
   * workspaces would be removed and how many bytes would be freed without
   * touching disk. Pass `{ dryRun: false }` to actually delete.
   *
   * Age is measured from each workspace directory's mtime. Trial directories
   * left empty after their workspaces are reaped are removed too.
   */
  async reapStaleFixtures(
    maxAgeDays = 7,
    opts: { dryRun?: boolean; now?: number } = {},
  ): Promise<ReapResult> {
    const dryRun = opts.dryRun ?? true;
    const now = opts.now ?? Date.now();
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    const base = this.stateRoot
      ? path.join(this.stateRoot, "fixtures")
      : path.join(os.tmpdir(), "howa");

    const result: ReapResult = { scanned: 0, wouldDelete: [], wouldFreeBytes: 0, errors: [] };

    let trialDirs: string[] = [];
    try {
      trialDirs = await fs.readdir(base);
    } catch {
      return result; // fixtures dir does not exist yet
    }

    for (const trialId of trialDirs) {
      const trialPath = path.join(base, trialId);
      let workspaces: string[] = [];
      try {
        const st = await fs.stat(trialPath);
        if (!st.isDirectory()) continue;
        workspaces = await fs.readdir(trialPath);
      } catch {
        continue;
      }

      let remaining = workspaces.length;
      for (const ws of workspaces) {
        const wsPath = path.join(trialPath, ws);
        result.scanned++;
        let mtimeMs: number;
        let bytes: number;
        try {
          const st = await fs.stat(wsPath);
          if (!st.isDirectory()) continue;
          mtimeMs = st.mtimeMs;
          bytes = await dirSize(wsPath);
        } catch (err) {
          result.errors.push({ path: wsPath, message: (err as Error).message });
          continue;
        }
        if (mtimeMs >= cutoff) continue; // still fresh

        result.wouldDelete.push({
          path: wsPath,
          trialId,
          ageMs: now - mtimeMs,
          bytes,
        });
        result.wouldFreeBytes += bytes;

        if (!dryRun) {
          try {
            await fs.rm(wsPath, { recursive: true, force: true });
            remaining--;
            logger.info(
              "reaper",
              `Removed stale fixture ${wsPath} (age ${Math.round((now - mtimeMs) / 86_400_000)}d, ${bytes} bytes)`,
            );
          } catch (err) {
            result.errors.push({ path: wsPath, message: (err as Error).message });
          }
        }
      }

      // Remove the trial directory if we emptied it.
      if (!dryRun && remaining === 0) {
        await fs.rm(trialPath, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (!dryRun && result.wouldDelete.length > 0) {
      logger.info(
        "reaper",
        `Reaped ${result.wouldDelete.length} stale fixture(s), freed ${result.wouldFreeBytes} bytes (maxAgeDays=${maxAgeDays})`,
      );
    }
    return result;
  }

  private async recursiveCopy(src: string, dst: string) {
    const entries = await fs.readdir(src, { withFileTypes: true }).catch(() => []);
    await fs.mkdir(dst, { recursive: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) await this.recursiveCopy(s, d);
      else await fs.copyFile(s, d);
    }
  }
}
