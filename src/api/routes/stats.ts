import { Router } from "express";
import { TrialStore } from "../../storage/index.js";

export function statsRouter(stateRoot: string): Router {
  const r = Router();
  const store = new TrialStore(stateRoot);

  r.get("/", async (_req, res) => {
    const trials = await store.listTrials();
    const totalTrials = trials.length;
    const completed = trials.filter((t) => t.verdict === "pass");
    const completedTrials = completed.length;
    const averageDurationMs =
      completedTrials > 0
        ? completed.reduce((sum, t) => sum + t.durationMs, 0) / completedTrials
        : 0;
    const uniqueTargets = new Set(trials.map((t) => t.agentId)).size;
    res.json({ totalTrials, completedTrials, averageDurationMs, uniqueTargets });
  });

  return r;
}
