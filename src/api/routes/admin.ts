import { Router } from "express";
import { readRecentLogs } from "../../utils/logger.js";

/**
 * Operator/admin endpoints: log tail and fixture cleanup.
 *
 * These are read-mostly diagnostics for an operator running Howa as a
 * background process. The cleanup endpoints let an operator reclaim disk
 * from preserved FAIL/ERROR fixtures without SSHing in to `rm -rf`.
 */
export function adminRouter(_stateRoot: string): Router {
  const r = Router();

  // GET /api/admin/logs — last 100 server log lines (most recent last).
  r.get("/logs", async (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;
    const entries = await readRecentLogs(limit);
    res.json({ entries });
  });

  return r;
}
