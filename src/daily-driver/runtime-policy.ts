import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "./contract.js";

export const DAILY_DRIVER_RUNTIME_POLICY_VERSION = "howa.ddv1-runtime.2026-08-22.2" as const;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");

export const TRUSTED_RUNTIME_PATHS = Object.freeze({
  launcher: path.join(repoRoot, "scripts/hermes-daily-driver-sandbox.sh"),
  terminal_sandbox: path.join(repoRoot, "scripts/daily-driver-bin/bash"),
  offline_executable: path.join(repoRoot, "scripts/hermes-daily-driver-offline.mjs"),
  production_executable: "/home/zen/.local/bin/hermes",
});

export interface RuntimeIdentity {
  policy_version: typeof DAILY_DRIVER_RUNTIME_POLICY_VERSION;
  policy_digest: string;
  launcher_path: string;
  launcher_digest: string;
  terminal_sandbox_digest: string;
  hermes_executable_path: string;
  hermes_executable_digest: string;
  hermes_version: string;
  hermes_commit: string;
}

async function exactFile(target: string): Promise<string> {
  const info = await fs.lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`trusted runtime component is not a regular file: ${target}`);
  return sha256(await fs.readFile(target));
}

export async function resolveTrustedRuntime(providerId: string): Promise<RuntimeIdentity> {
  const shimDir=path.dirname(TRUSTED_RUNTIME_PATHS.terminal_sandbox); const shimInfo=await fs.lstat(shimDir); if(!shimInfo.isDirectory()||shimInfo.isSymbolicLink()) throw new Error("trusted terminal shim directory is missing or substituted"); const shimEntries=(await fs.readdir(shimDir)).sort(); if(canonicalJson(shimEntries)!==canonicalJson(["bash"])) throw new Error("trusted terminal shim directory contains an unexpected executable");
  const bwrap=await fs.lstat("/usr/bin/bwrap"); if(!bwrap.isFile()||bwrap.isSymbolicLink()||(bwrap.mode&0o111)===0) throw new Error("Bubblewrap runtime is missing or substituted");
  const executable = providerId === "offline" ? TRUSTED_RUNTIME_PATHS.offline_executable : TRUSTED_RUNTIME_PATHS.production_executable;
  const [launcherDigest, sandboxDigest, executableDigest] = await Promise.all([
    exactFile(TRUSTED_RUNTIME_PATHS.launcher), exactFile(TRUSTED_RUNTIME_PATHS.terminal_sandbox), exactFile(executable),
  ]);
  if (launcherDigest === sandboxDigest) throw new Error("launcher and terminal sandbox identities must be independent");
  const policy = {
    policy_version: DAILY_DRIVER_RUNTIME_POLICY_VERSION,
    launcher_path: "scripts/hermes-daily-driver-sandbox.sh",
    launcher_digest: launcherDigest,
    terminal_sandbox_path: "scripts/daily-driver-bin/bash",
    terminal_sandbox_digest: sandboxDigest,
    executable_kind: providerId === "offline" ? "offline-proof" : "production-hermes",
    hermes_executable_digest: executableDigest,
    hermes_version: providerId === "offline" ? "offline-proof-v1" : "0.20.5",
    hermes_commit: providerId === "offline" ? executableDigest : "999703fd",
  };
  const policyDigest=sha256(canonicalJson(policy));
  const committed=JSON.parse(await fs.readFile(path.join(repoRoot,"contracts/howa-ddv1-runtime-policy.v2.json"),"utf8")) as {policy_version:string;identities:Array<{kind:string;launcher_digest:string;terminal_sandbox_digest:string;executable_digest:string;policy_digest:string}>};
  const kind=providerId==="offline"?"offline-proof":"production-hermes";
  if(committed.policy_version!==DAILY_DRIVER_RUNTIME_POLICY_VERSION||!committed.identities.some((item)=>item.kind===kind&&item.launcher_digest===launcherDigest&&item.terminal_sandbox_digest===sandboxDigest&&item.executable_digest===executableDigest&&item.policy_digest===policyDigest)) throw new Error("installed launcher/sandbox/executable bytes are not authorized by the frozen campaign policy");
  return { ...policy, policy_digest: policyDigest, launcher_path: TRUSTED_RUNTIME_PATHS.launcher, hermes_executable_path: executable };
}

export function rejectCandidateRuntimeOverrides(candidate: Record<string, unknown>): void {
  for (const key of ["hermes_command", "hermes_executable_path", "hermes_install_root", "hermes_version", "hermes_commit", "expected_launcher_digest", "terminal_sandbox_digest"]) {
    if (key in candidate) throw new Error(`candidate.${key} is forbidden; the frozen campaign runtime policy owns launcher identity`);
  }
}
