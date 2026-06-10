import { Router } from "express";
import { readRecentLogs, logger } from "../../utils/logger.js";
import { FixtureManager } from "../../runner/fixture-manager.js";

/**
 * Operator/admin endpoints: log tail and fixture cleanup.
 *
 * These are read-mostly diagnostics for an operator running Howa as a
 * background process. The cleanup endpoints let an operator reclaim disk
 * from preserved FAIL/ERROR fixtures without SSHing in to `rm -rf`.
 */
export function adminRouter(stateRoot: string): Router {
  const r = Router();
  const fixtures = new FixtureManager(stateRoot);

  // GET /api/admin/logs — last 100 server log lines (most recent last).
  r.get("/logs", async (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;
    const entries = await readRecentLogs(limit);
    res.json({ entries });
  });

  // GET /api/admin/cleanup — DRY RUN. Report which stale fixtures would be
  // reaped and how many bytes would be freed. Never deletes.
  r.get("/cleanup", async (req, res) => {
    const maxAgeDays = parseMaxAgeDays(req.query.maxAgeDays);
    const plan = await fixtures.reapStaleFixtures(maxAgeDays, { dryRun: true });
    res.json({
      dryRun: true,
      maxAgeDays,
      scanned: plan.scanned,
      wouldDelete: plan.wouldDelete,
      wouldFreeBytes: plan.wouldFreeBytes,
      errors: plan.errors,
    });
  });

  // POST /api/admin/cleanup — actually delete. Requires { confirm: true } in
  // the body to guard against accidental destruction.
  r.post("/cleanup", async (req, res) => {
    const body = (req.body ?? {}) as { confirm?: boolean; maxAgeDays?: number };
    if (body.confirm !== true) {
      res.status(400).json({
        error: "destructive operation requires { confirm: true } in the request body",
      });
      return;
    }
    const maxAgeDays = parseMaxAgeDays(body.maxAgeDays);
    const result = await fixtures.reapStaleFixtures(maxAgeDays, { dryRun: false });
    logger.info(
      "admin",
      `Manual cleanup removed ${result.wouldDelete.length} fixture(s), freed ${result.wouldFreeBytes} bytes`,
    );
    res.json({
      dryRun: false,
      maxAgeDays,
      scanned: result.scanned,
      deleted: result.wouldDelete,
      freedBytes: result.wouldFreeBytes,
      errors: result.errors,
    });
  });

  return r;
}

/** Parse a maxAgeDays query/body value, defaulting to 7 and clamping to >= 0. */
function parseMaxAgeDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}
