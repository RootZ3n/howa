import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAuthoritativeFixture } from "@howa/daily-driver/fixtures.js";
import { mintTrustedProviderCredential, runDailyDriverSuite, runDailyDriverTrial, type DailyDriverCandidate } from "@howa/daily-driver/runner.js";
import { findSecrets, redact } from "@howa/velum/redaction.js";
import { sha256 } from "@howa/daily-driver/contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const base: DailyDriverCandidate = {
  model_id: "offline/mock-v1", provider_id: "offline", provider_route: "direct", reasoning_level: "test",
  hermes_command: "/bin/bash", hermes_args: [path.join(fixtures, "daily-driver-candidate.sh"), "{trial_id}"],
  hermes_version: "test", hermes_commit: "test", hermes_configuration: { mode: "hostile-self-test" }, max_attempts: 1,
};

describe("Daily Driver hostile trust-boundary tests", () => {
  it("candidate tools cannot read credentials or forge usage/served identity or erase authoritative tool calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-hostile-"));
    const workspace = path.join(root, "fixture-attempt-1"); await fs.mkdir(workspace);
    const capture = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-capture-hostile-"));
    await fs.writeFile(path.join(capture, "usage.json"), "AUTHORITATIVE-USAGE");
    await fs.writeFile(path.join(capture, "state.db"), "AUTHORITATIVE-TOOL-CALLS");
    const command = `test ! -e /home/zen/.ssh && test ! -e /home/zen/.codex && test ! -e /home/zen/.claude && test ! -e /home/zen/.config && test ! -e /home/zen/.local/share && test ! -e '${capture}' && test -z "\${OPENAI_API_KEY-}\${MINIMAX_API_KEY-}\${MIMO_API_KEY-}" && ! printf FORGED > '${capture}/usage.json' && ! rm '${capture}/state.db' && git --version >/dev/null && node -e 'process.exit(0)'`;
    const result = spawnSync(path.join(process.cwd(), "scripts/daily-driver-bin/bash"), ["-c", command], { env: { ...process.env, HOWA_DAILY_DRIVER_WORKSPACE: workspace, HOWA_SANDBOX_FILESYSTEM_SELF_TEST: "1", OPENAI_API_KEY: "must-not-cross", MINIMAX_API_KEY: "must-not-cross" }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.readFile(path.join(capture, "usage.json"), "utf8")).toBe("AUTHORITATIVE-USAGE");
    expect(await fs.readFile(path.join(capture, "state.db"), "utf8")).toBe("AUTHORITATIVE-TOOL-CALLS");
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(capture, { recursive: true, force: true });
  });

  it("production tool shim requests an isolated network namespace and has no whole-root bind", async () => {
    const script = await fs.readFile(path.join(process.cwd(), "scripts/daily-driver-bin/bash"), "utf8");
    expect(script).toContain("--unshare-net");
    expect(script).not.toMatch(/--ro-bind\s+\/\s+\//);
    expect(script).not.toContain("--ro-bind /usr /usr");
    expect(script).toContain("--clearenv");
  });

  it("mints only the selected Codex credential into the trusted capture root", async () => {
    const capture = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-codex-auth-"));
    const rejectCapture = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-codex-reject-"));
    const prior = process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE;
    process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = JSON.stringify({ access_token: "access-token-for-hostile-test", refresh_token: "refresh-token-for-hostile-test" });
    try {
      await mintTrustedProviderCredential({ ...base, provider_credential_env: "HOWA_OPENAI_CODEX_AUTH_BUNDLE" }, capture);
      const value = JSON.parse(await fs.readFile(path.join(capture, "auth.json"), "utf8"));
      expect(value).toEqual({ version: 1, active_provider: "openai-codex", providers: { "openai-codex": { tokens: { access_token: "access-token-for-hostile-test", refresh_token: "refresh-token-for-hostile-test" } } } });
      expect((await fs.stat(path.join(capture, "auth.json"))).mode & 0o077).toBe(0);
      process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = JSON.stringify({ access_token: "access-token-for-hostile-test", refresh_token: "refresh-token-for-hostile-test", unrelated_provider: "must-reject" });
      await expect(mintTrustedProviderCredential({ ...base, provider_credential_env: "HOWA_OPENAI_CODEX_AUTH_BUNDLE" }, rejectCapture)).rejects.toThrow(/contain only/);
      await expect(runDailyDriverTrial({ candidate: { ...base, provider_id: "minimax", provider_credential_env: "MIMO_API_KEY", hermes_executable_path: "/bin/bash", hermes_install_root: "/nonexistent" }, output_root: capture, run_id: "credential-mismatch" }, "ddv1-07-unsupported-complete")).rejects.toThrow(/does not match provider/);
    } finally {
      if (prior === undefined) delete process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE; else process.env.HOWA_OPENAI_CODEX_AUTH_BUNDLE = prior;
      await fs.rm(capture, { recursive: true, force: true }); await fs.rm(rejectCapture, { recursive: true, force: true });
    }
  });

  it("effective prompt and tool identities bind the trusted Hermes implementation bytes", async () => {
    const install = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-hermes-runtime-"));
    await fs.mkdir(path.join(install, "agent"), { recursive: true }); await fs.mkdir(path.join(install, "tools"), { recursive: true });
    await fs.writeFile(path.join(install, "agent/prompt_builder.py"), "prompt-v1");
    await fs.writeFile(path.join(install, "toolsets.py"), "toolsets-v1"); await fs.writeFile(path.join(install, "model_tools.py"), "models-v1"); await fs.writeFile(path.join(install, "tools/terminal_tool.py"), "terminal-v1");
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-identity-"));
    const first = await runDailyDriverTrial({ candidate: { ...base, hermes_install_root: install }, output_root: output, run_id: "identity-first" }, "ddv1-07-unsupported-complete");
    await fs.writeFile(path.join(install, "agent/prompt_builder.py"), "prompt-v2");
    const promptChanged = await runDailyDriverTrial({ candidate: { ...base, hermes_install_root: install }, output_root: output, run_id: "identity-prompt" }, "ddv1-07-unsupported-complete");
    expect(promptChanged.receipt.system_prompt_digest).not.toBe(first.receipt.system_prompt_digest);
    expect(promptChanged.receipt.tool_registry_digest).toBe(first.receipt.tool_registry_digest);
    await fs.writeFile(path.join(install, "tools/terminal_tool.py"), "terminal-v2");
    const toolChanged = await runDailyDriverTrial({ candidate: { ...base, hermes_install_root: install }, output_root: output, run_id: "identity-tool" }, "ddv1-07-unsupported-complete");
    expect(toolChanged.receipt.tool_registry_digest).not.toBe(promptChanged.receipt.tool_registry_digest);
  });

  it("a static answer case statement that reads no fixture fails all twelve trials", async () => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-static-"));
    const results = await runDailyDriverSuite({ candidate: base, output_root: output, run_id: "hardcoded-static" });
    expect(results).toHaveLength(12);
    expect(results.every((item) => !item.receipt.accepted)).toBe(true);
  });

  it("every frozen Git fixture has identical semantic digests in two fresh attempts", async () => {
    for (const trial of ["ddv1-01-porcelain-parser", "ddv1-03-stash-reflog-preservation", "ddv1-04-local-vs-github-remote", "ddv1-11-bounded-implementation"]) {
      const aRoot = await fs.mkdtemp(path.join(os.tmpdir(), "howa-fixture-a-")); const bRoot = await fs.mkdtemp(path.join(os.tmpdir(), "howa-fixture-b-"));
      const a = await createAuthoritativeFixture(path.join(aRoot, "fixture"), trial); const b = await createAuthoritativeFixture(path.join(bRoot, "fixture"), trial);
      expect(a.snapshot.digest).toBe(b.snapshot.digest); expect(a.authority.authority_digest).toBe(b.authority.authority_digest);
      expect(Object.keys(a.snapshot.files).some((name) => name.startsWith(".git/"))).toBe(false);
    }
  });

  it("transport reset remains transport while malformed model output remains model failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-classes-"));
    const transport = await runDailyDriverTrial({ candidate: { ...base, hermes_args: [path.join(fixtures, "daily-driver-retry-candidate.sh")], max_attempts: 1 }, output_root: root, run_id: "transport-only" }, "ddv1-07-unsupported-complete");
    expect(transport.receipt.attempts[0]?.outcome).toBe("transport_failure"); expect(transport.receipt.raw_verdict).toBe("ERROR");
    const malformedScript = path.join(fixtures, "daily-driver-malformed-model.sh");
    const malformed = await runDailyDriverTrial({ candidate: { ...base, hermes_args: [malformedScript] }, output_root: root, run_id: "model-only" }, "ddv1-07-unsupported-complete");
    expect(malformed.receipt.attempts[0]?.outcome).toBe("model_failure"); expect(malformed.receipt.connection_failures).toHaveLength(0);
  });

  it("correction rounds are measured from actual rejected model attempts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-correction-"));
    const result = await runDailyDriverTrial({ candidate: { ...base, hermes_args: [path.join(fixtures, "daily-driver-correction-candidate.sh")], max_correction_rounds: 1, trusted_offline_reference: true }, output_root: root, run_id: "measured-correction" }, "ddv1-07-unsupported-complete");
    expect(result.receipt.accepted).toBe(true); expect(result.receipt.correction_rounds).toBe(1); expect(result.receipt.attempts.map((item) => item.outcome)).toEqual(["model_failure", "accepted_output"]);
  });

  it("Velum redacts hostile secret formats and retained evidence hashes its redacted bytes", async () => {
    const secrets = [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END OPENSSH PRIVATE KEY-----",
      "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc", "a".repeat(64), "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo5MDEyMzQ1Njc4OUFCQ0RFRkdISUpLTE1O",
      '{"api_key":"credential-value-123456"}',
    ];
    for (const value of secrets) { expect(findSecrets(value).length).toBeGreaterThan(0); expect(redact(value).redacted).not.toContain(value); }
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-redacted-"));
    const result = await runDailyDriverTrial({ candidate: { ...base, hermes_args: [path.join(fixtures, "daily-driver-secret-candidate.sh")] }, output_root: output, run_id: "redacted-digest" }, "ddv1-07-unsupported-complete");
    const ref = result.receipt.evidence_references.find((item) => item.kind === "stdout")!; const bytes = await fs.readFile(path.join(output, ref.path));
    expect(ref.digest).toBe(sha256(bytes)); expect(result.receipt.attempts[0]?.stdout_digest).toBe(ref.digest);
  });

  it("capture directories are removed after receipt export", async () => {
    const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("howa-ddv1-capture-cleanup-")));
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "howa-ddv1-cleanup-output-"));
    await runDailyDriverTrial({ candidate: base, output_root: output, run_id: "cleanup" }, "ddv1-07-unsupported-complete");
    const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("howa-ddv1-capture-cleanup-") && !before.has(name)); expect(after).toEqual([]);
  });
});
