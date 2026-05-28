import { spawnSync } from "node:child_process";

/** Single source of truth for Howa's version. */
export const HOWA_VERSION = "0.1.0";

/**
 * Back-compat alias. Receipts and trial summaries persist a `colosseumVersion`
 * field; downstream code that still imports COLOSSEUM_VERSION keeps working.
 */
export const COLOSSEUM_VERSION = HOWA_VERSION;

/**
 * Resolve the git commit of the *Howa repo itself* (not the workspace
 * under test). Returns "unknown" if not in a git checkout — never lies.
 */
export function getGitCommit(cwd: string = process.cwd()): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0) {
      const out = r.stdout.trim();
      if (out.length > 0) return out;
    }
  } catch {
    // fall through
  }
  return "unknown";
}
