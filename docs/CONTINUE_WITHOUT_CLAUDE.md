# Continue Without Claude — Howa

## What this repo does

Howa is the lab's model-evaluation arena. Runs trials (tool-calling,
verdict-ui, harness scenarios) and produces verdicts you can trust. Tasks
live in `tasks/`, runs in `howa-state/`.

## Common commands

```bash
npm run dev        # api + ui concurrently
npm run build      # tsc + vite build
npm test           # vitest run
npm run smoke      # scripts/smoke.mjs (pass scenario)
npm run smoke:fail # failure scenario
npm run typecheck  # tsc --noEmit
npm run verify:release  # release verification
npm run audit:release   # npm audit (moderate+)
```

## Safe edit zones

- `docs/`, `tasks/*/manifest.json` (declarative), test files
- `scripts/` — standalone helpers

## Dangerous edit zones

- `src/api/server.ts` — API composition root
- `src/core/runner.ts` — trial execution engine
- `tasks/operational-trust/`, `tasks/tool-calling/` — public-facing test fixtures

## How to recover

```bash
git log --oneline -5
git revert HEAD
# Or, from a packaged release:
unzip howa-windows-*.zip  # scripts/package-windows-zip.ps1
```

## Prompts for smaller models

```
"Add a new task manifest under tasks/<category>/<id>/manifest.json
matching the schema in an existing manifest in the same category."

"Add a vitest test in src/__tests__/ that loads the manifest and
checks the expected fixtures are present."
```

## Top tasks

1. Add CONTRIBUTING.md once external contributors arrive
2. Document task-manifest schema in docs/TASK-MANIFEST-SCHEMA.md
3. Wire `audit:release` into CI
4. Add a `release:dry-run` script that runs verify:release in temp dir
