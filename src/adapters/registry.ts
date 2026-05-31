import type { AgentAdapter } from "./types.js";
import { createAedisAdapter } from "./aedis.js";
import { createBetterClawAdapter } from "./betterclaw.js";
import { createOpenClawAdapter } from "./openclaw.js";
import { createHermesAdapter } from "./hermes.js";
import { createGenericCliAdapter } from "./generic-cli.js";
import { createLunaAdapter } from "./luna-http.js";
import { createMockAdapter } from "./mock.js";
import { createPtahAdapter } from "./ptah.js";
import {
  createPehAdapter,
  createPehV2Adapter,
} from "./peh-http.js";

const LAB_ADAPTERS = new Set(["ptah", "peh-v2"]);

const factories: Record<string, () => AgentAdapter> = {
  mock: createMockAdapter,
  aedis: createAedisAdapter,
  betterclaw: createBetterClawAdapter,
  openclaw: createOpenClawAdapter,
  hermes: createHermesAdapter,
  luna: createLunaAdapter,
  ptah: createPtahAdapter,
  peh: createPehAdapter,
  "peh-v2": createPehV2Adapter,
  "generic-cli": createGenericCliAdapter,
};

export function listAdapters(): AgentAdapter[] {
  return Object.entries(factories)
    .filter(([id]) => isPublicAdapter(id) || isLabAdapterEnabled(id))
    .map(([, f]) => f());
}

export function getAdapter(id: string): AgentAdapter {
  const f = factories[id];
  if (!f) {
    throw new Error(
      `Unknown adapter "${id}". Available: ${Object.keys(factories).join(", ")}`,
    );
  }
  return f();
}

export function adapterIds(): string[] {
  return Object.keys(factories);
}

export function publicAdapterIds(): string[] {
  return Object.keys(factories).filter(isPublicAdapter);
}

function isPublicAdapter(id: string): boolean {
  return !LAB_ADAPTERS.has(id);
}

function isLabAdapterEnabled(id: string): boolean {
  if (!LAB_ADAPTERS.has(id)) return false;
  // HOWA_LAB_ADAPTERS is the canonical env var for enabling lab adapters.
  const enabled = process.env.HOWA_LAB_ADAPTERS ?? "";
  return enabled
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .some((x) => x === id || x === "all");
}
