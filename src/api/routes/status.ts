import { Router } from "express";
import type { Express } from "express";
import { HOWA_VERSION } from "../../version.js";

/**
 * Count the number of registered route layers in the Express app.
 * Walks the internal router stack and counts layers that represent
 * either a mounted sub-router or a direct route handler.
 */
function countRoutes(app: Express): number {
  try {
    const stack: unknown[] = (app as unknown as { _router: { stack: unknown[] } })._router?.stack ?? [];
    return stack.length;
  } catch {
    return 0;
  }
}

export function statusRouter(app: Express): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      uptime: process.uptime(),
      version: HOWA_VERSION,
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
      },
      routes: countRoutes(app),
    });
  });
  return r;
}
