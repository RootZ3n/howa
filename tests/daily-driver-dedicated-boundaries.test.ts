import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addKnownCampaignCost, mintTrustedProviderCredential, runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { cleanupOwnedDailyDriverTemps, ownedDailyDriverTemp } from "./helpers/daily-driver-temp.js";

const offline: DailyDriverCandidate = { model_id:"offline/mock-v2", provider_id:"offline", provider_route:"direct", reasoning_level:"test", hermes_args:[], hermes_configuration:{toolsets:["terminal"]}, max_attempts:1 };
afterEach(cleanupOwnedDailyDriverTemps);

describe("Daily Driver dedicated trust-boundary regressions", () => {
  it("mints only a minimal Codex auth bundle and rejects smuggled fields/provider material", async () => {
    const validRoot = await ownedDailyDriverTemp("codex-auth-valid");
    const rejectedRoot = await ownedDailyDriverTemp("codex-auth-rejected");
    const previous = process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE;
    try {
      process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = JSON.stringify({ access_token:"synthetic-access-token-1234567890", refresh_token:"synthetic-refresh-token-1234567890" });
      await mintTrustedProviderCredential({ ...offline, provider_credential_env:"HOWA_OPENAI_CODEX_AUTH_BUNDLE" }, validRoot);
      const auth = JSON.parse(await fs.readFile(path.join(validRoot, "auth.json"), "utf8"));
      expect(auth).toEqual({ version:1, active_provider:"openai-codex", providers:{ "openai-codex":{ tokens:{ access_token:"synthetic-access-token-1234567890", refresh_token:"synthetic-refresh-token-1234567890" } } } });
      expect((await fs.stat(path.join(validRoot, "auth.json"))).mode & 0o077).toBe(0);
      for (const smuggled of [
        { access_token:"synthetic-access-token-1234567890", refresh_token:"synthetic-refresh-token-1234567890", providers:{ openrouter:{ api_key:"smuggled" } } },
        { access_token:"synthetic-access-token-1234567890", refresh_token:"synthetic-refresh-token-1234567890", MINIMAX_API_KEY:"smuggled-provider-material" },
      ]) {
        process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = JSON.stringify(smuggled);
        await expect(mintTrustedProviderCredential({ ...offline, provider_credential_env:"HOWA_OPENAI_CODEX_AUTH_BUNDLE" }, rejectedRoot)).rejects.toThrow(/contain only/);
      }
    } finally {
      if (previous === undefined) delete process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE; else process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = previous;
    }
  });

  it("cleans capture roots after timeout receipts and execution errors", async () => {
    const output = await ownedDailyDriverTemp("capture-cleanup");
    const timeoutRun = "n1-capture-timeout";
    const errorRun = "n1-capture-error";
    const newCaptureRoots = async (runId: string) => (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(`howa-ddv1-capture-${runId}-`));
    expect(await newCaptureRoots(timeoutRun)).toEqual([]);
    await runDailyDriverTrial({ candidate:{ ...offline, model_id:"offline/timeout-v1" }, output_root:output, run_id:timeoutRun, timeout_override_ms:300 }, "ddv1-07-unsupported-complete");
    expect(await newCaptureRoots(timeoutRun)).toEqual([]);
    await expect(runDailyDriverTrial({ candidate:{ ...offline, model_id:"offline/not-frozen" }, output_root:output, run_id:errorRun }, "ddv1-07-unsupported-complete")).rejects.toThrow(/not frozen/);
    expect(await newCaptureRoots(errorRun)).toEqual([]);
  }, 30_000);

  it("fails campaign cost accounting closed when API-equivalent cost is unknown", () => {
    expect(addKnownCampaignCost(0.25, 0.5, "ddv1-known")).toBe(0.75);
    expect(() => addKnownCampaignCost(0.25, null, "ddv1-unknown")).toThrow(/cost cannot be enforced.*unknown/);
  });
});
