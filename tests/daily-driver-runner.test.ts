import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDailyDriverSuite, runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { validateReceipt } from "@howa/daily-driver/contract.js";
import { verifyReceiptEvidence } from "@howa/daily-driver/evidence.js";
import { cleanupOwnedDailyDriverTemps, ownedDailyDriverTemp } from "./helpers/daily-driver-temp.js";

const candidate: DailyDriverCandidate={model_id:"offline/mock-v2",provider_id:"offline",provider_route:"direct",reasoning_level:"deterministic",hermes_args:[],hermes_configuration:{mode:"offline-proof",toolsets:["terminal"]},max_attempts:1,require_usage_file:true};
const root=ownedDailyDriverTemp; afterEach(cleanupOwnedDailyDriverTemps);

describe("Daily Driver production-path runner",()=>{
  it("runs all twelve through the authorized launcher and verifies every evidence bundle",async()=>{const output=await root("suite");const results=await runDailyDriverSuite({candidate,output_root:output,run_id:"offline-control"});expect(results).toHaveLength(12);for(const result of results){expect(()=>validateReceipt(result.receipt)).not.toThrow();expect(result.receipt.accepted).toBe(true);expect(result.receipt.hermes_launcher_digest).not.toBe(result.receipt.terminal_sandbox_digest);await expect(verifyReceiptEvidence(result.receipt,output,true)).resolves.toBeUndefined();expect(result.receipt.tool_calls.length).toBeGreaterThan(0);}},120_000);
  it("preserves a structurally classified retry",async()=>{const output=await root("retry");const result=await runDailyDriverTrial({candidate:{...candidate,model_id:"offline/retry-v1",max_attempts:2},output_root:output,run_id:"retry"},"ddv1-07-unsupported-complete");expect(result.receipt.accepted).toBe(true);expect(result.receipt.attempts.map(x=>x.outcome)).toEqual(["transport_failure","accepted_output"]);expect(result.receipt.connection_failures).toHaveLength(1);});
  it("keeps malformed model output a model failure",async()=>{const output=await root("malformed");const result=await runDailyDriverTrial({candidate:{...candidate,model_id:"offline/malformed-v1"},output_root:output,run_id:"malformed"},"ddv1-07-unsupported-complete");expect(result.receipt.attempts[0]?.outcome).toBe("model_failure");expect(result.receipt.connection_failures).toHaveLength(0);});
  it("rejects candidate launcher overrides before credential delivery or receipt creation",async()=>{const output=await root("launcher");const hostile={...candidate,model_id:"MiniMax-M3",provider_id:"minimax",provider_route:"direct:api.minimax.io/anthropic",provider_credential_env:"MINIMAX_API_KEY" as const,hermes_command:"/tmp/hostile"};await expect(runDailyDriverTrial({candidate:hostile,output_root:output,run_id:"custom-launcher"},"ddv1-01-porcelain-parser")).rejects.toThrow(/hermes_command is forbidden/);await expect(fs.stat(path.join(output,"receipts"))).rejects.toThrow();});
  it("refuses to overwrite application-write-once output",async()=>{const output=await root("once");const options={candidate,output_root:output,run_id:"same"};await runDailyDriverTrial(options,"ddv1-07-unsupported-complete");await expect(runDailyDriverTrial(options,"ddv1-07-unsupported-complete")).rejects.toMatchObject({code:"EEXIST"});});
});
