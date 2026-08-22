import { describe, expect, it } from "vitest";
import { canonicalJson, computeReceiptDigest, ContractValidationError, sealReceipt, sha256, validateReceipt, type DailyDriverReceiptV1 } from "@howa/daily-driver/contract.js";

function validReceipt(): DailyDriverReceiptV1 {
  const now = "2026-08-22T12:00:00.000Z";
  return sealReceipt({
    schema_version: "howa.hermes-daily-driver.receipt.v1", trial_id: "ddv1-01-porcelain-parser", trial_suite_version: "hermes-daily-driver.v1", run_id: "run-1", timestamp: now,
    model_id: "m", provider_id: "p", provider_route: "direct", reasoning_level: "max", served_model_identity: "m",
    hermes_version: "1", hermes_commit: "abc", hermes_configuration_digest: sha256("config"), system_prompt_digest: sha256("prompt"), tool_registry_digest: sha256("tools"), fixture_digest: sha256("fixture"),
    start_timestamp: now, end_timestamp: now, wall_clock_duration_ms: 0,
    attempts: [{ attempt: 1, started_at: now, finished_at: now, duration_ms: 0, exit_code: 0, outcome: "accepted_output", error_kind: null, retryable: false, stdout_digest: sha256("out"), stderr_digest: sha256("") }],
    retries: 0, connection_failures: [], timeout_events: [], compaction_events: [], input_tokens: 1, output_tokens: 1, charged_cost_usd: 0,
    tool_calls: [], mutation_observations: [], deterministic_checks: [{ id: "x", passed: true, details: "verified", evidence_refs: ["stdout"] }], raw_verdict: "PASS",
    evidence_references: [{ id: "stdout", kind: "stdout", path: "artifacts/out.txt", digest: sha256("out") }], correction_rounds: 0, accepted: true, disqualifier_codes: [],
  });
}

describe("Daily Driver contract", () => {
  it("canonicalizes object key order and produces a stable content digest", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const receipt = validReceipt();
    expect(computeReceiptDigest(receipt)).toBe(receipt.receipt_digest);
    expect(() => validateReceipt(receipt)).not.toThrow();
  });

  it("rejects forward versions, modified raw receipts, unknown fields, and secret exposure", () => {
    const forward = { ...validReceipt(), schema_version: "howa.hermes-daily-driver.receipt.v2" };
    expect(() => validateReceipt(forward)).toThrow(ContractValidationError);
    const tampered = { ...validReceipt(), accepted: false };
    expect(() => validateReceipt(tampered)).toThrow(/digest/);
    const unknown = { ...validReceipt(), surprise: true };
    expect(() => validateReceipt(unknown)).toThrow(/not allowed/);
    const secret = validReceipt();
    secret.deterministic_checks[0]!.details = "API_KEY=supersecretvalue";
    secret.receipt_digest = computeReceiptDigest(secret);
    expect(() => validateReceipt(secret)).toThrow(/secret-shaped/);
  });
});
