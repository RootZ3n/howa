export const DAILY_DRIVER_RATE_CARD_VERSION = "howa.ddv1-rates.2026-08-22.1" as const;

export interface RateCardEntry {
  provider_id: string;
  provider_route: string;
  model_id: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
  billing: "api_metered" | "subscription" | "token_plan";
  source_note: string;
}

/** Dated evaluator baseline. Updating prices requires a new version, never mutation. */
export const DAILY_DRIVER_RATE_CARD: readonly RateCardEntry[] = Object.freeze([
  { provider_id: "minimax", provider_route: "direct:api.minimax.io/anthropic", model_id: "MiniMax-M3", input_usd_per_million: 0.30, output_usd_per_million: 1.20, billing: "api_metered", source_note: "operator-verified public API rate, 2026-08-22" },
  { provider_id: "xiaomi", provider_route: "direct:api.xiaomimimo.com/v1", model_id: "mimo-v2.5-pro", input_usd_per_million: 0.40, output_usd_per_million: 1.22, billing: "api_metered", source_note: "operator-verified public API rate, 2026-08-22" },
  { provider_id: "openai-codex", provider_route: "codex-subscription", model_id: "gpt-5.6-luna", input_usd_per_million: 0.25, output_usd_per_million: 0.70, billing: "subscription", source_note: "operator-verified API-equivalent rate; subscription charge is separate, 2026-08-22" },
  { provider_id: "offline", provider_route: "direct", model_id: "offline/mock-v1", input_usd_per_million: 0, output_usd_per_million: 0, billing: "api_metered", source_note: "self-test only" },
]);

export function lookupRate(providerId: string, providerRoute: string, modelId: string): RateCardEntry | null {
  return DAILY_DRIVER_RATE_CARD.find((entry) => entry.provider_id === providerId && entry.provider_route === providerRoute && entry.model_id === modelId) ?? null;
}

export function apiEquivalentCost(entry: RateCardEntry | null, inputTokens: number | null, outputTokens: number | null): number | null {
  if (!entry || inputTokens === null || outputTokens === null) return null;
  return (inputTokens * entry.input_usd_per_million + outputTokens * entry.output_usd_per_million) / 1_000_000;
}
