import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "@howa/daily-driver/contract.js";
import { createAuthoritativeFixture, createCampaignEntropy, type FixtureAuthority } from "@howa/daily-driver/fixtures.js";
import { runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { HERMES_DAILY_DRIVER_V1 } from "@howa/daily-driver/suite.js";
import { validateTrialResult } from "@howa/daily-driver/validators.js";
import { cleanupOwnedDailyDriverTemps, ownedDailyDriverTemp } from "./helpers/daily-driver-temp.js";

const candidate: DailyDriverCandidate = { model_id:"offline/mock-v2", provider_id:"offline", provider_route:"direct", reasoning_level:"test", hermes_args:[], hermes_configuration:{toolsets:["terminal"]}, max_attempts:1 };
afterEach(cleanupOwnedDailyDriverTemps);

function replayReport(authority: FixtureAuthority): string {
  const expected = authority.expected;
  const status = typeof expected.required_status === "string" ? expected.required_status : authority.trial_id === "ddv1-06-masked-shell-failure" ? "INCOMPLETE" : authority.trial_id === "ddv1-09-concurrent-drift" ? "BLOCKED" : "COMPLETE";
  const evidence = authority.required_sources.map((source) => ({ claim:"prior campaign answer", source }));
  const observations: Record<string, unknown> = { ...expected };
  if (authority.trial_id === "ddv1-03-stash-reflog-preservation") observations.destructive_actions_planned = false;
  return JSON.stringify({ status, summary:"replayed prior-campaign answer", evidence, observations });
}

function toolPaths(authority: FixtureAuthority): string[] {
  return authority.required_sources.map((source) => source.startsWith("git:") ? `git ${source.slice(4)}` : source.startsWith("exec:") ? source.slice(5) : `cat ${source}`);
}

describe("Daily Driver N-1 campaign-bound oracles", () => {
  it("varies checked authority across all twelve while same-campaign regeneration stays deterministic", async () => {
    const root = await ownedDailyDriverTemp("n1-variation");
    const a = createCampaignEntropy("n1-campaign-a");
    const b = createCampaignEntropy("n1-campaign-b");
    for (const trial of HERMES_DAILY_DRIVER_V1.trials) {
      const a1 = await createAuthoritativeFixture(path.join(root, `${trial.id}-a1`), trial.id, a);
      const a2 = await createAuthoritativeFixture(path.join(root, `${trial.id}-a2`), trial.id, a);
      const b1 = await createAuthoritativeFixture(path.join(root, `${trial.id}-b1`), trial.id, b);
      expect(a1.snapshot.digest, `${trial.id} retry fixture`).toBe(a2.snapshot.digest);
      expect(a1.authority.authority_digest, `${trial.id} retry authority`).toBe(a2.authority.authority_digest);
      expect(canonicalJson(a1.authority.expected), `${trial.id} cross-campaign checked authority`).not.toBe(canonicalJson(b1.authority.expected));
    }
  }, 120_000);

  it("rejects prior-campaign answers on every trial even with claimed tool evidence", async () => {
    const root = await ownedDailyDriverTemp("n1-replay");
    const a = createCampaignEntropy("n1-replay-a");
    const b = createCampaignEntropy("n1-replay-b");
    for (const trial of HERMES_DAILY_DRIVER_V1.trials) {
      const prior = await createAuthoritativeFixture(path.join(root, `${trial.id}-prior`), trial.id, a);
      const current = await createAuthoritativeFixture(path.join(root, `${trial.id}-current`), trial.id, b);
      const outcome = await validateTrialResult({ trial, workspace:path.join(root, `${trial.id}-current`), stdout:replayReport(prior.authority), mutations:[], observed_tool_paths:toolPaths(current.authority), authority:current.authority });
      expect(outcome.accepted, `${trial.id} prior-campaign replay`).toBe(false);
    }
  }, 120_000);

  it("never retains the raw campaign nonce in public receipt evidence", async () => {
    const output = await ownedDailyDriverTemp("n1-no-raw-entropy");
    const entropy = createCampaignEntropy("n1-no-raw-entropy");
    const nonceHex = entropy.nonce.toString("hex");
    const result = await runDailyDriverTrial({ candidate, output_root:output, run_id:entropy.run_id, campaign_entropy:entropy }, "ddv1-03-stash-reflog-preservation");
    expect(result.receipt.accepted).toBe(true);
    for (const reference of result.receipt.evidence_references) {
      const bytes = await fs.readFile(path.join(output, reference.path));
      expect(reference.digest).toBe(sha256(bytes));
      expect(bytes.toString("utf8")).not.toContain(nonceHex);
    }
  }, 30_000);
});
