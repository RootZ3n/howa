/**
 * THE REQUEST PRINCIPAL this service presents to the Trio agents.
 *
 * Howa drives real agent turns through the Trio's `/chat` lane. Since that lane is behind an
 * authenticated principal, a request that presents none is refused before a model is reached —
 * correctly, because a shared bearer proves possession of a secret and says nothing about who is
 * asking, what they may run, or how the permission is revoked.
 *
 * The principal is NOT configuration:
 *
 *   - it does not come from `.env`, because a file in a repository is an authority the repository
 *     grants itself, and every backup and every checkout carries a copy;
 *   - it does not come from an ordinary environment variable, because anything that can set one
 *     can choose what this service is allowed to read;
 *   - it comes from the systemd credential channel, a root-owned file this process cannot write,
 *     read ONCE at startup: opened, read, closed.
 *
 * Absent, the value is empty and the agents refuse the request. That is the correct failure: an
 * adapter that silently degrades to unauthenticated is one whose refusals look like outages.
 *
 * The value is never logged, never returned in a result, and never written into a trial record.
 */
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The credential name the unit binds. One name, so a misconfigured unit fails loudly. */
const CREDENTIAL = "request-principal";

let cached: string | undefined;

/**
 * The assertion to present, or the empty string when this deployment holds none.
 *
 * Cached after the first read: the credential directory is materialised once for the lifetime of
 * the process, so re-reading it on every poll would be a syscall per request that could never
 * return anything different.
 */
export function requestPrincipal(): string {
  if (cached !== undefined) return cached;
  const directory = process.env["CREDENTIALS_DIRECTORY"];
  if (typeof directory !== "string" || directory.length === 0) {
    cached = "";
    return cached;
  }
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, CREDENTIAL), "r");
    cached = readFileSync(fd, "utf8").trim();
  } catch {
    cached = "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return cached;
}

/**
 * Headers for one authenticated request against an agent.
 *
 * `X-Pehverse-Principal` carries authorization and is omitted entirely when absent, rather than
 * sent empty: a header with no value is a claim, and this service has none to make.
 */
export function principalHeaders(base: Record<string, string> = {}): Record<string, string> {
  const principal = requestPrincipal();
  return principal.length > 0 ? { ...base, "X-Pehverse-Principal": principal } : { ...base };
}
