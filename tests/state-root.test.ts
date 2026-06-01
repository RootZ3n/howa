import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveStateRoot, defaultStateRoot } from "@howa/storage/index.js";

// Regression guard for the BLOCKER where `process.env.HOWA_STATE_ROOT ?? default`
// let an empty string through (systemd + start.sh export HOWA_STATE_ROOT=""),
// producing stateRoot="" → relative "trials"/"receipts" dirs in the repo root.
describe("resolveStateRoot (B2 regression)", () => {
  it("falls back to the default when unset", () => {
    expect(resolveStateRoot(undefined)).toBe(defaultStateRoot());
  });

  it("treats an empty string as unset (the migration bug)", () => {
    expect(resolveStateRoot("")).toBe(defaultStateRoot());
  });

  it("treats whitespace-only as unset", () => {
    expect(resolveStateRoot("   ")).toBe(defaultStateRoot());
  });

  it("honors an explicit absolute value", () => {
    expect(resolveStateRoot("/pehverse/repos/howa/howa-state")).toBe(
      "/pehverse/repos/howa/howa-state",
    );
  });

  it("never yields an empty or relative root for unset/blank env", () => {
    for (const v of [undefined, "", "   "]) {
      const r = resolveStateRoot(v);
      expect(r).not.toBe("");
      expect(path.isAbsolute(r)).toBe(true);
      // Specifically: it must not be a bare relative "trials" parent.
      expect(path.join(r, "trials")).toBe(path.join(defaultStateRoot(), "trials"));
    }
  });

  it("defaultStateRoot is always absolute and ends in howa-state", () => {
    const d = defaultStateRoot();
    expect(path.isAbsolute(d)).toBe(true);
    expect(path.basename(d)).toBe("howa-state");
  });
});
