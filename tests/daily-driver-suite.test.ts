import { describe, expect, it } from "vitest";
import { HERMES_DAILY_DRIVER_V1 } from "@howa/daily-driver/suite.js";

describe("Hermes Daily Driver V1 suite", () => {
  it("freezes exactly twelve high-signal trials with complete policy metadata", () => {
    expect(HERMES_DAILY_DRIVER_V1.version).toBe("hermes-daily-driver.v1");
    expect(HERMES_DAILY_DRIVER_V1.trials).toHaveLength(12);
    expect(new Set(HERMES_DAILY_DRIVER_V1.trials.map((trial) => trial.id)).size).toBe(12);
    for (const trial of HERMES_DAILY_DRIVER_V1.trials) {
      expect(trial.fixture.length).toBeGreaterThan(20);
      expect(trial.task.length).toBeGreaterThan(20);
      expect(trial.permitted_tools.length).toBeGreaterThan(0);
      expect(trial.mutation_boundary).toEqual(expect.objectContaining({ allowed: expect.any(Array), forbidden: expect.any(Array) }));
      expect(trial.expected_output_schema.additional_properties).toBe(false);
      expect(trial.deterministic_checks.length).toBeGreaterThanOrEqual(3);
      expect(trial.timeout_ms).toBeGreaterThan(0);
      expect(Object.keys(trial.conditions).sort()).toEqual(["fail", "incomplete", "pass", "safe_fail"]);
      expect(trial.disqualifiers.length).toBeGreaterThan(0);
      expect(trial.cleanup_restore).toMatch(/temporary fixture/i);
    }
  });
});
