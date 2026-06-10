import { Router } from "express";
import { getAdapter } from "../../adapters/registry.js";
import { getPack } from "../../packs/registry.js";
import { runTrial } from "../../runner/trial-runner.js";
import { TrialStore, TRIAL_SCHEMA_VERSION } from "../../storage/index.js";
import { HOWA_VERSION, getGitCommit } from "../../version.js";
import { logger } from "../../utils/logger.js";
import type { TrialEvent } from "../../types.js";

interface LiveTrial {
  trialId: string;
  events: TrialEvent[];
  done: boolean;
  /** SSE clients listening on this trial. */
  clients: Set<(e: TrialEvent) => void>;
}

export function trialsRouter(stateRoot: string): Router {
  const r = Router();
  const live = new Map<string, LiveTrial>();
  const store = new TrialStore(stateRoot);
  const maxLiveEvents = 1_000;

  r.get("/", async (_req, res) => {
    const trials = await store.listTrials();
    res.json({ trials });
  });

  r.post("/", async (req, res) => {
    const body = req.body as {
      agent: string;
      packs: string[];
      model?: string;
      location?: "local" | "cloud" | "unknown";
      // Operator-supplied identity/cost overrides — see truth-resolver.ts.
      // These promote the adapter's truth contract from "unknown" so the
      // receipt reflects what the operator vouched for.
      provider?: string;
      costMode?: "reported" | "estimated" | "free" | "unknown";
      costSource?: string;
      extra?: Record<string, unknown>;
    };
    if (!body?.agent || !Array.isArray(body.packs) || body.packs.length === 0) {
      res.status(400).json({ error: "agent and packs[] are required" });
      return;
    }
    let adapter, packs;
    try {
      adapter = getAdapter(body.agent);
      packs = body.packs.map(getPack);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }

    const trialId = `trial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slot: LiveTrial = { trialId, events: [], done: false, clients: new Set() };
    live.set(trialId, slot);
    const pushLive = (e: TrialEvent) => {
      slot.events.push(e);
      if (slot.events.length > maxLiveEvents) {
        slot.events.splice(0, slot.events.length - maxLiveEvents);
      }
      for (const c of slot.clients) c(e);
      if (e.phase === "complete") slot.done = true;
    };

    // Fold operator overrides into `extra` so the runner's
    // truth-resolver picks them up via operatorOverridesFrom().
    const mergedExtra: Record<string, unknown> = { ...(body.extra ?? {}) };
    if (body.provider && !("provider" in mergedExtra)) mergedExtra.provider = body.provider;
    if (body.costMode && !("costMode" in mergedExtra)) mergedExtra.costMode = body.costMode;
    if (body.costSource && !("costSource" in mergedExtra)) mergedExtra.costSource = body.costSource;
    runTrial({
      trialId,
      adapter,
      packs,
      stateRoot,
      baseRunOptions: {
        model: body.model,
        location: body.location,
        extra: mergedExtra,
      },
      onEvent: (e) => {
        pushLive(e);
      },
    }).catch((err) => {
      const now = Date.now();
      logger.error("trials", `Trial ${trialId} crashed: ${(err as Error).message}`);
      pushLive({
        sequence: slot.events.length + 1,
        trialId,
        timestamp: now,
        phase: "complete",
        severity: "critical",
        message: `Runner error: ${(err as Error).message}`,
        adapter: { id: body.agent, version: "unknown" },
        source: "runner",
        mode: "buffered",
      });
      slot.done = true;
      const errorHonesty = {
        provisional: true,
        noBehavioralEvidence: true,
        allBehavioralFailed: true,
        costExcludedFromTrust: false,
        noBehavioralCategories: true,
        behavioralN: 0,
        provisionalThreshold: 8,
        // Phase-3 stamps: an errored trial cannot have validated either
        // identity or cost; mark them unknown so this row is never
        // ranked for value/identity comparisons downstream.
        modelUnknown: true,
        costUnknown: true,
        noOpExpectedPassCount: 0,
      };
      void store.saveTrial({
        trialId,
        agentId: body.agent,
        adapter: body.agent,
        packs: body.packs,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        verdict: "error",
        score: {
          passRate: 0,
          perCategory: [],
          costEfficiency: { category: "overall", value: 0, n: 0, reasons: [] },
          trust: 0,
          reasons: [`Runner error: ${(err as Error).message}`],
          // Synthetic error-path score — every honesty signal is on so
          // the UI/leaderboard treats this entry as the failed,
          // no-evidence, non-authoritative record it actually is.
          honesty: errorHonesty,
        },
        testCount: 0,
        passCount: 0,
        failCount: 0,
        velumDecision: "warn",
        howaVersion: HOWA_VERSION,
        gitCommit: getGitCommit(),
        adapterVersion: "unknown",
        packVersions: Object.fromEntries(body.packs.map((p) => [p, "unknown"])),
        adapterTruth: {
          modelIdentity: "unknown",
          costTruth: "unknown",
          eventStructure: "unstructured",
          toolSupport: false,
        },
        liveMode: "buffered",
        eventCount: slot.events.length,
        isMockTrial: body.agent === "mock",
        honesty: errorHonesty,
        schemaVersion: TRIAL_SCHEMA_VERSION,
      });
      void store.saveTrialEvents(trialId, slot.events);
    });

    res.status(202).json({ trialId });
  });

  r.get("/:id", async (req, res) => {
    const summary = await store.getTrial(req.params.id);
    if (!summary) {
      res.status(404).json({ error: "no such trial" });
      return;
    }
    res.json(summary);
  });

  r.get("/:id/events", async (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const slot = live.get(req.params.id);
    if (!slot) {
      const saved = await store.getTrialEvents(req.params.id);
      if (saved.length === 0) {
        const summary = await store.getTrial(req.params.id);
        if (!summary) {
          res.write(`event: error\ndata: {"error":"no such trial"}\n\n`);
          res.end();
          return;
        }
      }
      for (const e of saved) {
        res.write(`data: ${JSON.stringify({ ...e, mode: "replay" })}\n\n`);
      }
      res.end();
      return;
    }
    // Replay buffered events first.
    for (const e of slot.events) {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    }
    if (slot.done) {
      res.write(`event: end\ndata: {}\n\n`);
      res.end();
      return;
    }
    const onEvent = (e: TrialEvent) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.phase === "complete") {
        res.write(`event: end\ndata: {}\n\n`);
        res.end();
      }
    };
    slot.clients.add(onEvent);
    req.on("close", () => slot.clients.delete(onEvent));
  });

  return r;
}
