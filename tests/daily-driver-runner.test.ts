import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDailyDriverSuite, runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { HERMES_DAILY_DRIVER_V1 } from "@howa/daily-driver/suite.js";
import { canonicalJson, validateReceipt } from "@howa/daily-driver/contract.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const candidate: DailyDriverCandidate = {
  model_id: "offline/mock-v1",
  provider_id: "offline",
  provider_route: "direct",
  reasoning_level: "test",
  hermes_command: "/bin/bash",
  hermes_args: ["-c", `out=$(/home/zen/.hermes/node/bin/node ${path.join(fixtureDir, "daily-driver-reference-candidate.mjs")} "$1"); printf '%s\\n' "$out"`, "reference", "{trial_id}"],
  hermes_version: "test",
  hermes_commit: "test",
  hermes_configuration: { mode: "offline-self-test", session: "fresh" },
  max_attempts: 1,
  candidate_accommodations: ["offline deterministic self-test; syscall telemetry replaces Hermes transcript"],
  trusted_offline_reference: true,
};

async function tempRoot(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `howa-${label}-`));
}

describe("Daily Driver runner", () => {
  it("passes all twelve trials with the deterministic offline candidate and emits sealed write-once receipts", async () => {
    const root = await tempRoot("ddv1-suite");
    const results = await runDailyDriverSuite({ candidate, output_root: root, run_id: "offline-control" });
    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(() => validateReceipt(result.receipt)).not.toThrow();
      expect(result.receipt.accepted).toBe(true);
      expect(result.receipt.raw_verdict).toBe("PASS");
      expect(result.receipt.deterministic_checks.every((check) => check.passed)).toBe(true);
      expect((await fs.stat(result.receipt_path)).mode & 0o222).toBe(0);
      expect(await fs.readFile(result.receipt_path, "utf8")).toBe(`${canonicalJson(result.receipt)}\n`);
    }
    expect(results.map((result) => result.receipt.trial_id)).toEqual(HERMES_DAILY_DRIVER_V1.trials.map((trial) => trial.id));
  }, 60_000);

  it("preserves a retryable provider interruption as attempt one", async () => {
    const root = await tempRoot("ddv1-retry");
    const result = await runDailyDriverTrial({
      candidate: { ...candidate, hermes_command: "/bin/bash", hermes_args: [path.join(fixtureDir, "daily-driver-retry-candidate.sh")], max_attempts: 2 },
      output_root: root,
      run_id: "retry-control",
    }, "ddv1-07-unsupported-complete");
    expect(result.receipt.accepted).toBe(true);
    expect(result.receipt.attempts).toHaveLength(2);
    expect(result.receipt.attempts[0]).toEqual(expect.objectContaining({ outcome: "transport_failure", error_kind: "CONNECTION_RESET", retryable: true }));
    expect(result.receipt.attempts[1]).toEqual(expect.objectContaining({ outcome: "accepted_output" }));
    expect(result.receipt.retries).toBe(1);
    expect(result.receipt.connection_failures).toHaveLength(1);
    expect(result.receipt.evidence_references.some((ref) => ref.path.includes("attempt-1.stderr"))).toBe(true);
  });

  it("does not overwrite an already exported application-write-once receipt", async () => {
    const root = await tempRoot("ddv1-no-overwrite");
    const options = { candidate, output_root: root, run_id: "same-run" };
    await runDailyDriverTrial(options, "ddv1-07-unsupported-complete");
    await expect(runDailyDriverTrial(options, "ddv1-07-unsupported-complete")).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("uses isolated Hermes usage and state.db as trusted accounting and tool telemetry", async () => {
    const root = await tempRoot("ddv1-hermes-capture");
    const result = await runDailyDriverTrial({
      candidate: {
        ...candidate,
        hermes_args: [path.join(fixtureDir, "daily-driver-hermes-candidate.sh"), "{usage_file}"],
        require_usage_file: true,
        require_transcript: true,
        max_trial_cost_usd: 0.02,
      },
      output_root: root,
      run_id: "hermes-capture",
    }, "ddv1-07-unsupported-complete");
    expect(result.receipt.accepted).toBe(true);
    expect(result.receipt.input_tokens).toBe(17);
    expect(result.receipt.output_tokens).toBe(9);
    expect(result.receipt.charged_cost_usd).toBeNull();
    expect(result.receipt.api_equivalent_cost_usd).toBe(0);
    expect(result.receipt.tool_calls).toEqual([expect.objectContaining({ attempt: 1, sequence: 1, name: "terminal", exit_code: 0 })]);
    expect(result.receipt.evidence_references.some((ref) => ref.path.endsWith("attempt-1.hermes-transcript.json"))).toBe(true);
    expect(result.receipt.evidence_references.some((ref) => ref.path.endsWith("attempt-1.hermes-usage.json"))).toBe(true);
  });
});
