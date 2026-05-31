/**
 * Lab Agent Contract probe — shared helper used by the HTTP-speaking
 * adapters (luna-http, peh-http, ptah, and the optional Aedis HTTP
 * variant) to introspect a peer's canonical surface.
 *
 * Returns the contract-shaped /health, /agent, /capabilities responses
 * with timing. Used by:
 *   - adapter.health()  — surface the 2-second budget result
 *   - registry probes   — populate adapter cards in the UI
 *   - OpenClaw          — peer registration
 *
 * Failures are reported as `{ok: false, reason}` rather than thrown so
 * the calling adapter can bubble them into its existing health-result
 * shape.
 */

const DEFAULT_TIMEOUT_MS = 2_000;

export interface CanonicalCapabilityRow {
  supported: boolean;
  implemented: boolean;
  verified: boolean;
  proven: boolean;
  requiresApproval: boolean;
  limitations: string[];
  evidence: string | null;
  lastProofAt: string | null;
}

export interface CanonicalAgentIdentity {
  id: string;
  name: string;
  role: string;
  serviceUrl: string;
  healthUrl: string;
  uiUrl: string | null;
  tailscaleUrls: { service?: string; ui?: string };
  workspaceRoots: string[];
  authorityTier: string;
  primarySpecialties: string[];
  allowedTools: string[];
  ownerAgent: string | null;
  peerAgents: string[];
  contractVersion: string;
  agentVersion: string;
}

export interface CanonicalAgentHealth {
  ok: boolean;
  service: string;
  version: string;
  status: "ok" | "degraded" | "starting" | "stopping";
  uptimeMs: number;
  reasons?: string[];
  identity: { id: string; role: string; authorityTier: string };
}

export interface CanonicalCapabilities {
  ok: true;
  service: string;
  contractVersion: string;
  capabilities: Record<string, CanonicalCapabilityRow>;
}

export interface ContractProbeResult {
  ok: boolean;
  reason?: string;
  health?: CanonicalAgentHealth;
  healthMs?: number;
  identity?: CanonicalAgentIdentity;
  capabilities?: CanonicalCapabilities;
}

export interface ContractProbeOptions {
  baseUrl: string;
  /** Per-call timeout in ms; default 2000 to honour the contract §1.1 budget. */
  timeoutMs?: number;
}

export async function probeAgentContract(opts: ContractProbeOptions): Promise<ContractProbeResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const healthUrl = `${base}/health`;
  const t0 = Date.now();
  let healthRes: Response;
  try {
    healthRes = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, reason: `/health unreachable at ${healthUrl}: ${(err as Error).message}` };
  }
  const healthMs = Date.now() - t0;
  if (!healthRes.ok) {
    return { ok: false, reason: `/health returned HTTP ${healthRes.status} at ${healthUrl}`, healthMs };
  }
  const healthBody = (await healthRes.json().catch(() => null)) as CanonicalAgentHealth | null;
  if (!healthBody || typeof healthBody.service !== "string") {
    return { ok: false, reason: `/health returned non-canonical body at ${healthUrl}`, healthMs };
  }
  if (healthMs > timeoutMs) {
    return {
      ok: false,
      reason: `/health exceeded ${timeoutMs}ms budget (${healthMs}ms) — contract §1.1`,
      healthMs,
      health: healthBody,
    };
  }

  // /agent and /capabilities are fetched in parallel; failures degrade
  // the result without aborting — peers still get the canonical health.
  const [identityRes, capabilitiesRes] = await Promise.allSettled([
    fetch(`${base}/agent`, { signal: AbortSignal.timeout(timeoutMs) }),
    fetch(`${base}/capabilities`, { signal: AbortSignal.timeout(timeoutMs) }),
  ]);

  const identity = await safeJson<CanonicalAgentIdentity>(identityRes);
  const capabilities = await safeJson<CanonicalCapabilities>(capabilitiesRes);

  const result: ContractProbeResult = {
    ok: true,
    health: healthBody,
    healthMs,
  };
  if (identity) result.identity = identity;
  if (capabilities) result.capabilities = capabilities;
  return result;
}

async function safeJson<T>(settled: PromiseSettledResult<Response>): Promise<T | undefined> {
  if (settled.status !== "fulfilled") return undefined;
  const res = settled.value;
  if (!res.ok) return undefined;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
