import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, computeReceiptDigest, sha256, type DailyDriverReceiptV1 } from "@howa/daily-driver/contract.js";
import { adjudicateReceiptEvidence, verifyReceiptEvidence } from "@howa/daily-driver/evidence.js";
import { runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { TRUSTED_RUNTIME_PATHS } from "@howa/daily-driver/runtime-policy.js";
import { cleanupOwnedDailyDriverTemps, ownedDailyDriverTemp } from "./helpers/daily-driver-temp.js";

const candidate:DailyDriverCandidate={model_id:"offline/mock-v2",provider_id:"offline",provider_route:"direct",reasoning_level:"k1-proof",hermes_args:[],hermes_configuration:{toolsets:["terminal"]},max_attempts:1};
afterEach(cleanupOwnedDailyDriverTemps);

function reseal(receipt:DailyDriverReceiptV1):DailyDriverReceiptV1{receipt.receipt_digest=computeReceiptDigest(receipt);return receipt;}

describe("Daily Driver K-1 retained expected authority",()=>{
  it("retains the exact validator input and permits nonce-free post-hoc adjudication of pass and fail",async()=>{
    const root=await ownedDailyDriverTemp("k1-adjudication");
    const passing=await runDailyDriverTrial({candidate,output_root:root,run_id:"k1-pass"},"ddv1-10-provider-retry-accounting");
    const failing=await runDailyDriverTrial({candidate:{...candidate,model_id:"offline/secret-v1"},output_root:root,run_id:"k1-fail"},"ddv1-10-provider-retry-accounting");
    const pass=await adjudicateReceiptEvidence(passing.receipt,root,true);const fail=await adjudicateReceiptEvidence(failing.receipt,root,true);
    expect(pass.accepted).toBe(true);expect(fail.accepted).toBe(false);expect(fail.disqualifier_codes).toContain("SECRET_EXPOSURE");
    const expected=pass.expected.event_codes as string[];const submitted=pass.candidate_submitted?.event_codes as string[];expect(expected[0]).toBeTruthy();expect(submitted[0]).toBe(expected[0]);expect(pass.consumed_expected_fields).toContain("event_codes");expect(pass.comparisons.find((item)=>item.id==="retry.events")?.passed).toBe(true);expect(pass.comparisons.find((item)=>item.id==="authority.expected-correspondence")?.passed).toBe(true);
    expect(fail.candidate_submitted).toBeNull();expect(fail.comparisons.find((item)=>item.id==="output.schema")?.passed).toBe(false);expect(fail.comparisons.find((item)=>item.id==="authority.expected-correspondence")?.passed).toBe(true);
  },30_000);

  it("rejects the complete expected-evidence tampering matrix",async()=>{
    const source=await ownedDailyDriverTemp("k1-tamper-source");const a=await runDailyDriverTrial({candidate,output_root:source,run_id:"k1-campaign-a"},"ddv1-10-provider-retry-accounting");const campaignB=await runDailyDriverTrial({candidate,output_root:source,run_id:"k1-campaign-b"},"ddv1-10-provider-retry-accounting");const trialB=await runDailyDriverTrial({candidate,output_root:source,run_id:"k1-trial-b"},"ddv1-05-health-vs-workflow");const expected=a.receipt.evidence_references.find((item)=>item.kind==="trusted_expected")!;
    await verifyReceiptEvidence(a.receipt,source,true);
    const variants=await Promise.all(Array.from({length:7},async(_,index)=>{const root=await ownedDailyDriverTemp(`k1-tamper-${index}`);await fs.cp(source,root,{recursive:true});return root;}));
    await fs.unlink(path.join(variants[0]!,expected.path));await expect(verifyReceiptEvidence(a.receipt,variants[0]!,false)).rejects.toThrow();
    await fs.chmod(path.join(variants[1]!,expected.path),0o600);await fs.appendFile(path.join(variants[1]!,expected.path),"modified");await expect(verifyReceiptEvidence(a.receipt,variants[1]!,false)).rejects.toThrow(/evidence bytes mismatch/);
    for(const [index,other] of [[2,campaignB],[3,trialB]] as const){const otherExpected=other.receipt.evidence_references.find((item)=>item.kind==="trusted_expected")!;await fs.chmod(path.join(variants[index]!,expected.path),0o600);await fs.writeFile(path.join(variants[index]!,expected.path),await fs.readFile(path.join(source,otherExpected.path)));await expect(verifyReceiptEvidence(a.receipt,variants[index]!,false)).rejects.toThrow();}
    const wrongExpected=reseal({...structuredClone(a.receipt),expected_object_digest:sha256("substituted expected")});await expect(verifyReceiptEvidence(wrongExpected,variants[4]!,false)).rejects.toThrow(/expected object digest/);
    const wrongAuthority=reseal({...structuredClone(a.receipt),authority_digest:sha256("substituted authority")});await expect(verifyReceiptEvidence(wrongAuthority,variants[5]!,false)).rejects.toThrow(/authority digest/);
    const value=JSON.parse(await fs.readFile(path.join(variants[6]!,expected.path),"utf8")) as Record<string,unknown>;value.expected={event_codes:["wrong"]};const bytes=`${canonicalJson(value)}\n`;await fs.chmod(path.join(variants[6]!,expected.path),0o600);await fs.writeFile(path.join(variants[6]!,expected.path),bytes);await expect(verifyReceiptEvidence(a.receipt,variants[6]!,false)).rejects.toThrow(/evidence bytes mismatch/);
  },30_000);

  it("keeps trusted expected evidence outside the real terminal sandbox even when its host path is guessed",async()=>{
    const root=await ownedDailyDriverTemp("k1-isolation");const workspace=path.join(root,"fixture-attempt-1");const protectedRoot=await ownedDailyDriverTemp("k1-protected-output");const protectedFile=path.join(protectedRoot,"artifacts","run","trial","attempt-1.trusted-expected.json");await fs.mkdir(workspace,{recursive:true});await fs.mkdir(path.dirname(protectedFile),{recursive:true});await fs.writeFile(protectedFile,"trusted expected sentinel\n",{mode:0o400});
    const result=spawnSync(TRUSTED_RUNTIME_PATHS.terminal_sandbox,["-lc",`test ! -e ${JSON.stringify(protectedFile)} && test ! -e /home/zen/.ssh && test ! -e /home/zen/.codex`],{cwd:workspace,encoding:"utf8",env:{HOWA_DAILY_DRIVER_WORKSPACE:workspace,PATH:process.env.PATH}});
    expect({status:result.status,stderr:result.stderr}).toEqual({status:0,stderr:""});expect(await fs.readFile(protectedFile,"utf8")).toBe("trusted expected sentinel\n");
  });
});
