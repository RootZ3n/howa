# Agent Capability Matrix Audit

Date: 2026-05-17

## Summary

The `/agents` page previously rendered `adapter.capabilities` directly as boolean
YES/NO pills. Those values are static adapter claims from registration time, not
runtime proof. Because the UI iterated object entries from each adapter, the page
also had no explicit canonical matrix contract at the presentation boundary.

This made support look proven when it was only claimed, and made unsupported or
untested capability categories harder to audit.

## Where Capabilities Are Declared

- Static capability claims live on `AgentAdapter.capabilities` in
  `src/adapters/types.ts`.
- The canonical boolean shape is `Capabilities` in `src/types.ts`:
  `streaming`, `toolUse`, `fileEditing`, `shellExecution`, `modelSelection`,
  `reportsCost`, `reportsTokens`.
- Concrete adapter declarations live in:
  - `src/adapters/mock.ts`
  - `src/adapters/generic-cli.ts`
  - `src/adapters/aedis.ts`
  - `src/adapters/openclaw.ts`
  - `src/adapters/betterclaw.ts`
  - `src/adapters/hermes.ts`
  - `src/adapters/luna-http.ts`
  - `src/adapters/squidley-http.ts`
  - `src/adapters/ptah.ts`

## Where `/agents` Gets Data

- `src/api/routes/agents.ts` lists adapters from `src/adapters/registry.ts`.
- Before this change, the route returned `capabilities: a.capabilities`.
- `src/ui/pages/Agents.tsx` rendered `Object.entries(a.capabilities)` directly.
- After this change, the route returns:
  - `capabilities`: static claims, retained for compatibility.
  - `capabilityMatrix`: canonical, evidence-aware state map.
  - `capabilityList`: canonical ordered rows for UI rendering.

## Static Claims vs Runtime Evidence

Current evidence sources:

- `static`: adapter declaration only. This can produce `SUPPORTED_NOT_PROVEN`,
  `UNSUPPORTED`, or `UNKNOWN`, but never `PROVEN`.
- `trial`: trial summary evidence such as live mode or adapter setup failure.
- `receipt`: per-test proof such as live stream mode, structured tool events,
  changed files/artifacts, concrete model metadata, and reported cost/token data.
- `probe`: reserved for future explicit capability probes.
- `unknown`: missing declaration or unreadable evidence.

## Capability State Meanings

- `PROVEN`: runtime evidence exists in a trial or receipt.
- `SUPPORTED_NOT_PROVEN`: adapter claims support, but no proof has been recorded.
- `UNSUPPORTED`: adapter declares no support.
- `BLOCKED_BY_CONFIG`: adapter claims support, but the latest relevant trial could
  not run because setup/configuration failed.
- `NOT_TESTED`: reserved for explicit probe/test scheduling where no result exists.
- `UNKNOWN`: Colosseum has neither a declaration nor evidence.

## Capability Test Coverage In Packs

Existing packs test agent behavior, not every platform capability directly:

- `repo-editing` can produce file-editing evidence through changed diffs and
  artifacts.
- `stamina` can observe structured progress/tool events when adapters emit them.
- `local-model` can validate reported model/location/cost truthfulness when those
  fields are present.
- `truthfulness` and `safety` exercise behavioral correctness but do not directly
  prove every adapter capability.

Capabilities not comprehensively tested by current packs:

- Streaming as a dedicated probe.
- Tool use as a dry-run capability probe independent of task success.
- Shell execution as a harmless bounded command probe.
- Model selection as a dedicated requested-model round trip.
- Cost and token reporting as isolated probes.

## Luna Tool Use vs Streaming

Luna declares `toolUse: true` and `streaming: false` in
`src/adapters/luna-http.ts`. The old UI displayed that as "toolUse: yes" and
"streaming: no" from static metadata. Under the normalized matrix, Luna's tool use
is `SUPPORTED_NOT_PROVEN` until a receipt records tool evidence, while streaming is
`UNSUPPORTED` because the adapter declares it unsupported.

## Pack Selection And Skips

Pack selection does not currently skip packs based on adapter capability claims.
The runner uses `adapter.capabilities.streaming` only to decide live vs buffered
timeline mode. New Trial uses adapter metadata to prefill the truth contract shown
to the operator, but that is not a proof signal.

## Probe Recommendations

Safe probes that can be added without weakening safety:

- `reportsTokens`: run a short prompt and require reported token fields.
- `reportsCost`: run a short prompt and require a reported cost field or explicit
  zero-cost proof.
- `modelSelection`: request a benign model override and require echoed effective
  model/provider metadata.
- `streaming`: use adapters with `streamEvents` and verify live event mode.
- `toolUse`: dry-run a harmless structured tool call where the adapter supports it.
- `fileEditing`: use a sandbox fixture and require one bounded file write.
- `shellExecution`: only when the adapter declares safe shell support; execute a
  harmless bounded command inside the sandbox and record the command event.

Until those probes exist, unsupported features are explicit and claimed features
remain `SUPPORTED_NOT_PROVEN` unless existing trial/receipt evidence proves them.
