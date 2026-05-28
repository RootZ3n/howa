# Howa Last-Call Verification

Date: 2026-05-23

## Git State

- Branch: `master`
- Baseline commit: `e35a046 colosseum: add CONTINUE_WITHOUT_CLAUDE.md`
- Dirty state found: untracked `.git-recovered/`
- Classification: generated/recovery Git metadata, not source, docs, state, or release artifact.
- Action: ignored with `.gitignore`; left on disk for operator recovery authority.

## Build And Test

- `npm run typecheck`: passed.
- `npm test`: initially failed 5 stale contract assertions.
- `npx vitest run tests/adapters.test.ts tests/capabilities.test.ts tests/ptah-setup.test.ts`: passed after test-only fixes.
- `npm run build`: passed.
- `npm run smoke`: passed with the mock adapter and stamina pack.

## Fixes

- Updated HTTP adapter tests to mock the current Lab Agent Contract `/health` shape.
- Updated Luna capability expectation to `SUPPORTED_NOT_PROVEN` for static streaming, file-editing, and shell-execution claims.
- Updated Ptah/Luna unreachable-health tests to match the current contract-probe failure wording.
- No scoring, benchmark, pack, adapter runtime, or service behavior changed.

## Service

- Installed unit: `/etc/systemd/system/colosseum.service`
- User unit: none.
- Start command: `npm run start` -> `node dist/api/server.js`
- Bind: `127.0.0.1:18799`
- State root: `/mnt/ai/colosseum/colosseum-state`
- Restart result: active/running.

## Endpoint Checks

- `http://127.0.0.1:18799/api/health`: OK.
- `http://127.0.0.1:18799/api/packs`: OK.
- `http://127.0.0.1:18799/api/trials`: OK.
- `http://100.118.60.13:18799/api/health`: not reachable because the installed unit binds to loopback.

## Remaining Blockers

- None for local Howa operation or Crucible-adjacent trial/evaluation use on the same host.
- Tailscale/private-lab reachability requires an explicit operator decision to set `COLOSSEUM_HOST=0.0.0.0` or a Tailscale IP in the systemd unit.
