# Hermes Daily Driver V1

Howa owns isolated execution, frozen fixtures, transcript/tool capture, deterministic validation, raw verdicts, and immutable receipts. Luak consumes those receipts through the versioned `howa.hermes-daily-driver.receipt.v1` data contract; neither repository imports the other.

`howa daily-driver list` prints the frozen suite. `howa daily-driver run` accepts a secret-free candidate descriptor. Each attempt receives a new synthetic fixture and a new `HERMES_HOME`; retryable transport failures remain evidence and are never overwritten. Hermes's `--usage-file` is authoritative for served identity, tokens, and estimated charge. Howa reads the isolated Hermes `state.db` after exit to preserve the raw transcript and derive tool-call telemetry. The candidate's final JSON is only a claim: validators inspect fixture state and assign the receipt verdict.

Receipts are canonical sorted-key JSON, SHA-256 sealed, written once with `O_EXCL`, and made read-only. The schema rejects unknown keys, secrets, unsupported versions, broken evidence links, inconsistent acceptance, and identity mismatches. Artifact files are also write-once. Luak must preserve receipt bytes unchanged and store derived scoring separately.

The sandbox makes the host root read-only, hides all of `/pehverse`, remounts only the exact synthetic workspace and isolated session home writable, and restores only the Hermes installation under the otherwise empty production Hermes directory. Network remains available for the provider call. The runner validates the exact `/tmp/howa-ddv1-*` roots before entering the sandbox.

The control campaign is intentionally not automatic. See `campaigns/hermes-daily-driver-v1/README.md` after the evaluator self-tests pass.
