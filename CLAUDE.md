# Howa

Howa (formerly "Colosseum") is the **agent evaluation framework** of the Pehverse
lab — Jeffrey Miller's multi-agent AI development ecosystem. It is a local-first
**agent proving ground**: it runs AI agents through repeatable trials and writes
JSON + Markdown "receipts" for every verdict, so agent behavior is audited
against evidence instead of vibes. Agents are judged on five pillars —
**truthfulness, safety, reliability, stamina, and evidence** — with truthfulness
trials and model/cost identity tracked honestly (unknowns stay "unknown", never
invented). It ships a CLI, an Express HTTP API, and a React arena UI. TypeScript,
ESM, Node >= 18.17, pnpm.

## Build / Test / Dev commands

Use the exact scripts from `package.json` (run via `pnpm`):

```bash
# Dev (hot reload, two processes: api + ui)
pnpm run dev            # api: 127.0.0.1:18799  ui: 127.0.0.1:5180 (open this in dev)
pnpm run dev:api        # tsx watch src/api/server.ts
pnpm run dev:ui         # vite

# Build
pnpm run build          # tsc -p tsconfig.build.json && vite build
pnpm run build:cli      # tsc -p tsconfig.build.json (CLI only)

# Run (after build)
pnpm run start          # node dist/api/server.js  → http://127.0.0.1:18799
pnpm run cli -- <args>  # tsx src/cli/index.ts  (e.g. cli -- list agents)

# Test
pnpm test               # vitest run (unit tests, no server)
pnpm run test:integration  # vitest run --config vitest.integration.config.ts
pnpm run test:all          # vitest run --config vitest.all.config.ts
pnpm run test:watch        # vitest (watch mode)
pnpm run typecheck         # tsc --noEmit

# Smoke / release gates
pnpm run smoke          # node scripts/smoke.mjs pass (build + mock-agent trial, no external deps)
pnpm run smoke:fail     # node scripts/smoke.mjs fail (verifies honest FAIL reporting)
pnpm run verify:release # node scripts/verify-release.mjs (full release gate)
pnpm run audit:release  # npm audit --audit-level=moderate --omit=optional
```

There is **no JS lint stack** configured in v0.1 — `typecheck` and `test` are the
current quality gates. After any trial-corpus change, also run
`node scripts/howa-diagnostic.mjs` (exits non-zero if a trust guard regresses).

## Key conventions

- **TypeScript, ESM** (`"type": "module"`). Relative imports use explicit `.js`
  extensions (e.g. `@howa/scoring/score.js`) even though sources are `.ts`.
- **Path alias** `@howa` → `./src` (configured in `vitest.config.ts`; also in
  `tsconfig`). Tests import from `@howa/...`.
- **Tests** use **Vitest** with `globals: true`, `environment: "node"`, located
  in `tests/**/*.test.ts` (not co-located with source). Shared test helpers live
  in `tests/_helpers/`.
- **Shared types** live in `src/types.ts` and are imported across adapters,
  packs, runner, scoring, and receipts. Core unions: `Verdict`
  (`pass|fail|warn|skipped|error`), `ModelLocation` (`local|cloud|unknown`).
- **Honesty / "no fake precision" is a hard rule.** Cost and model identity may
  be `unknown`/`not reported`; never fabricate numbers. Silence (no observable
  behavior) earns zero, not a pass. Mock trials are quarantined and flagged.
- Adapters only **translate** to/from agents; they cannot reach into scoring.
- Local-first: API binds `127.0.0.1` by default, **no built-in HTTP auth**.

## Architecture notes

A trial flows: **CLI/API → runner → adapter (runs the agent) → Velum guard →
packs (assertions) → scoring → receipts/storage → UI/CLI surfaces**.

`src/` modules:

- **`adapters/`** — the `AgentAdapter` contract (`types.ts`, `registry.ts`) and
  one impl per agent: `mock` (deterministic, bundled), `aedis`, `betterclaw`,
  `openclaw`, `hermes`, `generic-cli` (CLI-wrapping), `peh-http`, `artist-http`
  (HTTP), `mechanic` (lab-only). `truth-resolver.ts` / `contract-probe.ts` resolve
  reported model/cost truth and health-check adapters.
- **`runner/`** — trial orchestration (`trial-runner.ts`), fixture workspace
  setup/cleanup (`fixture-manager.ts`), artifact capture (`artifact-collector.ts`),
  unified-diff summaries (`diff.ts`).
- **`packs/`** — test packs (directories): `truthfulness`, `repo-editing`,
  `safety`, `stamina`, `context-stamina`, `local-model`, `tool-calling`; plus
  `clarification.ts`, `no-evidence.ts`, `registry.ts`, `types.ts` (`TestResult`).
- **`scoring/`** — `score.ts` (weighted, category aggregation, cost-efficiency)
  and `verdict.ts` (verdict roll-up). Safety weighs heaviest.
- **`velum/`** — pattern-based guard layer: `guard.ts`, `instruction-leak.ts`
  (prompt-injection / paraphrase leak detection), `redaction.ts` (secret
  redaction). Records evidence; never hides results.
- **`receipts/`** — `receipt.ts` + `receipt-store.ts`: JSON + Markdown receipts
  per trial.
- **`storage/`** — `index.ts`: persistence into the `howa-state/` directory.
- **`api/`** — Express HTTP server (`server.ts`) + `routes/`. Serves trial
  lifecycle, an SSE `TrialEvent` stream, and the UI.
- **`cli/`** — `index.ts`: the `howa` command-line entry (commander). Subcommands
  include `list agents`, `list packs`, `run`, `report`.
- **`ui/`** — Vite + React arena UI (`components/`, `pages/`). Static UI assets
  also under top-level `ui/`.
- **`utils/`** — `atomic-write.ts`, `logger.ts`. `version.ts` / `capabilities.ts`
  at `src/` root.

**State** lives under `./howa-state/` (override with `--state` or
`HOWA_STATE_ROOT`): `receipts/`, `trials/`, `agents/`, `trial-events/`,
`reports/`, `notes/`, `fixtures/`, `artifacts/`. Receipts land at
`howa-state/receipts/<trialId>/` as paired `.json` + `.md` files. The
`howaVersion`/schema fields and `howa-state/` layout are kept verbatim from the
Colosseum era so older evidence stays valid.

Further design docs: `docs/ARCHITECTURE.md`, `docs/ADAPTERS.md`,
`docs/TEST-PACKS.md`, `docs/SCORING.md`, `docs/RUNNING.md`.
