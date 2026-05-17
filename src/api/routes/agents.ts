import { Router } from "express";
import { listAdapters } from "../../adapters/registry.js";
import {
  buildCapabilityMatrix,
  capabilityList,
} from "../../capabilities.js";
import { ReceiptStore } from "../../receipts/receipt-store.js";
import { TrialStore } from "../../storage/index.js";

export function agentsRouter(stateRoot: string): Router {
  const r = Router();
  const trialStore = new TrialStore(stateRoot);
  const receiptStore = new ReceiptStore(stateRoot);

  r.get("/", async (_req, res) => {
    const trials = await trialStore.listTrials();
    const receiptsByTrialId: Record<string, Awaited<ReturnType<ReceiptStore["list"]>>> = {};
    for (const trial of trials) {
      receiptsByTrialId[trial.trialId] = await receiptStore.list(trial.trialId);
    }

    const items = listAdapters().map((a) => {
      const capabilityMatrix = buildCapabilityMatrix(a, { trials, receiptsByTrialId });
      return {
      id: a.id,
      name: a.name,
      description: a.description,
      version: a.version,
      // Static adapter claims. These are not proof.
      capabilities: a.capabilities,
      capabilityMatrix,
      capabilityList: capabilityList(capabilityMatrix),
      // Truth contract is read-only metadata on the adapter; surfacing it
      // here lets the UI render it honestly instead of reconstructing it
      // from heuristics. Purely additive — no behavior change.
      truth: a.truth,
      // Protocol metadata (optional) is included only when the adapter
      // declares it. Lets the UI show e.g. "<aedis> submit <prompt>" so
      // operators can see exactly how prompts will be dispatched.
      ...(a.protocol ? { protocol: a.protocol } : {}),
      };
    });
    res.json({ agents: items });
  });
  return r;
}
