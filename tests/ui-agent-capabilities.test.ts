import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CANONICAL_CAPABILITIES } from "@colosseum/capabilities.js";

describe("Agents UI capability matrix", () => {
  it("renders every card from the canonical capability list", async () => {
    const src = await fs.readFile(
      path.resolve(process.cwd(), "src/ui/pages/Agents.tsx"),
      "utf8",
    );
    expect(src).toContain("capabilityList");
    expect(src).toContain("capabilityRows(a).map");
    for (const key of CANONICAL_CAPABILITIES) {
      expect(src).toContain(`"${key}"`);
    }
  });

  it("renders explicit states and matching CSS classes", async () => {
    const src = await fs.readFile(
      path.resolve(process.cwd(), "src/ui/pages/Agents.tsx"),
      "utf8",
    );
    const css = await fs.readFile(
      path.resolve(process.cwd(), "src/ui/styles.css"),
      "utf8",
    );
    for (const state of [
      "PROVEN",
      "SUPPORTED_NOT_PROVEN",
      "UNSUPPORTED",
      "BLOCKED_BY_CONFIG",
      "NOT_TESTED",
      "UNKNOWN",
    ]) {
      expect(src).toContain(state);
    }
    for (const className of [
      ".capability-state.proven",
      ".capability-state.supported",
      ".capability-state.blocked",
      ".capability-state.unsupported",
      ".capability-state.unknown",
    ]) {
      expect(css).toContain(className);
    }
  });
});
