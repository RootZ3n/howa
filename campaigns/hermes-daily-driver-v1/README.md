# Hermes Daily Driver V1 control campaign

These candidate descriptors are secret-free and deliberately inert. They pin Hermes 0.20.5 (`999703fd`), one-shot safe mode, a fresh `HERMES_HOME`, the terminal toolset, Max reasoning, trusted usage capture, and the Howa bubblewrap boundary.

The accounting envelope is 2,400,000 uncached input tokens plus 240,000 output tokens per 12-trial candidate. At the prices checked on 2026-08-22 this is $1.008 for MiniMax M3 standard (all prompts below 512K), $1.2528 for MiMo v2.5 Pro, and $0.768 at API list price for Luna. The Luna route is Codex subscription-included, so its expected incremental charge is $0 while it still consumes plan quota. Campaign limits are post-receipt tripwires, not provider-side prepaid limits; the operator must set account hard limits before authorization if a strict billing ceiling is required.

Run only after both repositories' self-tests pass and an operator authorizes paid calls:

```bash
cd /tmp/howa-hermes-daily-driver-v1
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/minimax-m3-direct.candidate.json --run-id ddv1-m3-YYYYMMDD --output /tmp/howa-ddv1-control/m3
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/mimo-v2.5-pro-direct.candidate.json --run-id ddv1-mimo-YYYYMMDD --output /tmp/howa-ddv1-control/mimo
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/gpt-5.6-luna-max-codex.candidate.json --run-id ddv1-luna-YYYYMMDD --output /tmp/howa-ddv1-control/luna
```

Required credentials are supplied through the operator environment (`MINIMAX_API_KEY`, `XIAOMI_API_KEY`, or an existing Codex OAuth login). They are never stored in a candidate, prompt, artifact, or receipt. Any credential-shaped output disqualifies the trial and is redacted before export.
