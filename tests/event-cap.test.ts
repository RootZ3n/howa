import { describe, expect, it } from "vitest";
import { enforceTimelineCap } from "@howa/runner/trial-runner.js";

const MAX = 5_000;
const HEAD = 50;

describe("timeline event cap (H2)", () => {
  it("preserves the first 50 events and caps at 5000 when overflowing", () => {
    const timeline: number[] = [];
    let discarded = 0;
    // Push 6,000 monotonically-increasing events, capping as we go (mirrors emit()).
    for (let i = 0; i < 6_000; i++) {
      timeline.push(i);
      discarded += enforceTimelineCap(timeline, MAX, HEAD);
    }

    expect(timeline.length).toBe(MAX);
    expect(discarded).toBe(6_000 - MAX); // 1,000 discarded

    // First 50 events (0..49) are intact.
    expect(timeline.slice(0, HEAD)).toEqual(Array.from({ length: HEAD }, (_, i) => i));
    // The event right after the head is NOT event 50 — early-middle events were dropped.
    expect(timeline[HEAD]).toBeGreaterThan(HEAD);
    // The most recent event is always retained.
    expect(timeline[timeline.length - 1]).toBe(5_999);
  });

  it("does nothing while under the cap", () => {
    const timeline = Array.from({ length: 100 }, (_, i) => i);
    const discarded = enforceTimelineCap(timeline, MAX, HEAD);
    expect(discarded).toBe(0);
    expect(timeline.length).toBe(100);
  });

  it("discards exactly the overflow on a single oversized push", () => {
    const timeline = Array.from({ length: MAX + 1 }, (_, i) => i);
    const discarded = enforceTimelineCap(timeline, MAX, HEAD);
    expect(discarded).toBe(1);
    expect(timeline.length).toBe(MAX);
    // Head preserved, the single dropped event is at index HEAD.
    expect(timeline.slice(0, HEAD)).toEqual(Array.from({ length: HEAD }, (_, i) => i));
    expect(timeline[HEAD]).toBe(HEAD + 1);
  });
});
