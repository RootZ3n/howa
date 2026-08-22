import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256, validateReceipt, type DailyDriverReceiptV1, type EvidenceReference } from "./contract.js";
import { DAILY_DRIVER_RATE_CARD_VERSION } from "./rate-card.js";
import { DAILY_DRIVER_RUNTIME_POLICY_VERSION, resolveTrustedRuntime } from "./runtime-policy.js";

export const EVIDENCE_MANIFEST_VERSION = "howa.hermes-daily-driver.evidence-manifest.v1" as const;
export interface EvidenceManifestEntry { path: string; byte_length: number; digest: string; evidence_class: EvidenceReference["kind"]; run_id: string; trial_id: string; }
export interface EvidenceManifest { schema_version: typeof EVIDENCE_MANIFEST_VERSION; run_id: string; trial_id: string; entries: EvidenceManifestEntry[]; }

function normalized(relative: string): string {
  const value = relative.split(path.sep).join("/");
  if (!value || path.posix.isAbsolute(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`unsafe evidence path: ${relative}`);
  return value;
}
function inside(root: string, relative: string): string {
  const rel = normalized(relative); const target = path.resolve(root, rel); const base = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(base)) throw new Error(`evidence path escapes root: ${relative}`); return target;
}
async function writeOnce(target: string, bytes: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true }); const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o444);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function buildEvidenceManifest(outputRoot: string, runId: string, trialId: string, refs: EvidenceReference[]): Promise<{ manifest: EvidenceManifest; path: string; digest: string }> {
  const seen = new Set<string>(); const entries: EvidenceManifestEntry[] = [];
  for (const ref of refs) {
    const relative = normalized(ref.path); if (seen.has(relative)) throw new Error(`duplicate evidence path: ${relative}`); seen.add(relative);
    const target = inside(outputRoot, relative); const info = await fs.lstat(target); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`evidence must be a regular non-symlink file: ${relative}`);
    const bytes = await fs.readFile(target); const digest = sha256(bytes); if (digest !== ref.digest) throw new Error(`evidence digest changed before manifest: ${relative}`);
    entries.push({ path: relative, byte_length: bytes.length, digest, evidence_class: ref.kind, run_id: runId, trial_id: trialId });
  }
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest: EvidenceManifest = { schema_version: EVIDENCE_MANIFEST_VERSION, run_id: runId, trial_id: trialId, entries };
  const relative = `manifests/${runId}/${trialId}.evidence-manifest.json`; const bytes = `${canonicalJson(manifest)}\n`;
  await writeOnce(inside(outputRoot, relative), bytes);
  return { manifest, path: relative, digest: sha256(bytes) };
}
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []; async function walk(dir: string): Promise<void> { for (const entry of await fs.readdir(dir,{withFileTypes:true})) { const full=path.join(dir,entry.name); if(entry.isSymbolicLink()) throw new Error(`symlink in evidence scope: ${full}`); if(entry.isDirectory()) await walk(full); else if(entry.isFile()) out.push(path.relative(root,full).split(path.sep).join("/")); else throw new Error(`non-file evidence entry: ${full}`); } } await walk(root); return out.sort();
}
export async function verifyReceiptEvidence(receipt: DailyDriverReceiptV1, outputRoot: string, verifyLocalRuntime = true): Promise<void> {
  validateReceipt(receipt);
  const manifestPath = inside(outputRoot, receipt.evidence_manifest_path); const manifestInfo = await fs.lstat(manifestPath); if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()) throw new Error("evidence manifest is not a regular file");
  const manifestBytes=await fs.readFile(manifestPath); if(sha256(manifestBytes)!==receipt.evidence_manifest_digest) throw new Error("evidence manifest digest mismatch");
  const manifest=JSON.parse(manifestBytes.toString("utf8")) as EvidenceManifest;
  if(manifest.schema_version!==EVIDENCE_MANIFEST_VERSION||manifest.run_id!==receipt.run_id||manifest.trial_id!==receipt.trial_id||!Array.isArray(manifest.entries)) throw new Error("evidence manifest identity/schema mismatch");
  const expectedRefs=new Map(receipt.evidence_references.map((ref)=>[normalized(ref.path),ref])); if(expectedRefs.size!==receipt.evidence_references.length) throw new Error("duplicate receipt evidence paths");
  const seen=new Set<string>(); for(const entry of manifest.entries){ const rel=normalized(entry.path); if(seen.has(rel)) throw new Error(`duplicate manifest path: ${rel}`); seen.add(rel); const ref=expectedRefs.get(rel); if(!ref||ref.digest!==entry.digest||ref.kind!==entry.evidence_class||entry.run_id!==receipt.run_id||entry.trial_id!==receipt.trial_id) throw new Error(`manifest/reference mismatch: ${rel}`); const target=inside(outputRoot,rel); const info=await fs.lstat(target); if(!info.isFile()||info.isSymbolicLink()) throw new Error(`invalid evidence file: ${rel}`); const bytes=await fs.readFile(target); if(bytes.length!==entry.byte_length||sha256(bytes)!==entry.digest) throw new Error(`evidence bytes mismatch: ${rel}`); }
  if(seen.size!==expectedRefs.size) throw new Error("manifest omits receipt evidence");
  const artifactRoot=inside(outputRoot,`artifacts/${receipt.run_id}/${receipt.trial_id}`); const actual=(await walkFiles(artifactRoot)).map((rel)=>`artifacts/${receipt.run_id}/${receipt.trial_id}/${rel}`); const declared=[...seen].filter((rel)=>rel.startsWith(`artifacts/${receipt.run_id}/${receipt.trial_id}/`)).sort(); if(canonicalJson(actual)!==canonicalJson(declared)) throw new Error("evidence directory contains missing, extra, or renamed files");
  const identityRef=receipt.evidence_references.find((ref)=>ref.path.endsWith("runtime-identity.json")); if(!identityRef) throw new Error("runtime identity evidence missing"); const identity=JSON.parse(await fs.readFile(inside(outputRoot,identityRef.path),"utf8")) as Record<string,unknown>;
  for(const key of ["hermes_launcher_digest","terminal_sandbox_digest","hermes_executable_digest","runtime_policy_version","runtime_policy_digest","hermes_configuration_digest","system_prompt_digest","tool_registry_digest","cost_rate_card_version","campaign_entropy_commitment"] as const) if(identity[key]!==receipt[key]) throw new Error(`runtime identity mismatch: ${key}`);
  if(receipt.runtime_policy_version!==DAILY_DRIVER_RUNTIME_POLICY_VERSION||receipt.cost_rate_card_version!==DAILY_DRIVER_RATE_CARD_VERSION) throw new Error("unsupported frozen policy or rate card");
  const authorityRef=receipt.evidence_references.find((ref)=>ref.path.endsWith("trusted-authority.json")); if(!authorityRef) throw new Error("trusted campaign authority evidence missing"); const authority=JSON.parse(await fs.readFile(inside(outputRoot,authorityRef.path),"utf8")) as Record<string,unknown>; const exactAuthorityKeys=["authority_digest","entropy_commitment","fixture_digest","run_id","schema_version","trial_id"]; if(canonicalJson(Object.keys(authority).sort())!==canonicalJson(exactAuthorityKeys)) throw new Error("trusted campaign authority has unexpected fields"); if(authority.schema_version!=="howa.ddv1-authority.v2"||authority.run_id!==receipt.run_id||authority.trial_id!==receipt.trial_id||authority.fixture_digest!==receipt.fixture_digest||authority.entropy_commitment!==receipt.campaign_entropy_commitment||typeof authority.authority_digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(authority.authority_digest)) throw new Error("trusted campaign authority mismatch");
  if(verifyLocalRuntime){ const actualRuntime=await resolveTrustedRuntime(receipt.provider_id); if(actualRuntime.launcher_digest!==receipt.hermes_launcher_digest||actualRuntime.terminal_sandbox_digest!==receipt.terminal_sandbox_digest||actualRuntime.hermes_executable_digest!==receipt.hermes_executable_digest||actualRuntime.policy_digest!==receipt.runtime_policy_digest) throw new Error("installed trusted runtime bytes do not match receipt"); }
}
