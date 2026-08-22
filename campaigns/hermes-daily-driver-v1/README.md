# Hermes Daily Driver V1 control campaign

These candidate descriptors are secret-free and deliberately inert. They pin Hermes 0.20.5 (`999703fd`), one-shot safe mode, a trusted capture root outside the fixture, the terminal toolset, Max reasoning, enforced 24-turn/8,192-output-token limits, and the minimal air-gapped tool boundary. Exactly one named provider credential is admitted to Hermes and none reaches terminal tools.

The full accounting envelope is 2,400,000 uncached input tokens plus 240,000 output tokens: $1.008 for MiniMax M3, $1.2528 for MiMo v2.5 Pro, and $0.768 API-equivalent for Luna. The separate three-trial canary (`01`, `08`, `11`) ceilings are $0.252, $0.3132, and $0.192 respectively. Luna charged dollars remain unknown/null while subscription quota and API-equivalent cost are both reported. These are enforced evaluator ceilings from trusted usage plus the dated rate card; provider account hard limits remain the final billing backstop.

Required credentials are supplied through the operator environment: `MINIMAX_API_KEY`, `MIMO_API_KEY`, or `HOWA_OPENAI_CODEX_AUTH_BUNDLE`. The Codex value is a JSON object containing only `access_token` and `refresh_token`; Howa mints a minimal isolated Hermes auth store containing only `openai-codex`. Credentials are never stored in a candidate, prompt, artifact, receipt, or terminal-tool environment.

Run a three-trial canary only after both repositories' self-tests pass, CC independently re-audits this remediation, and an operator authorizes paid calls:

```bash
cd /tmp/howa-hermes-daily-driver-v1
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/minimax-m3-direct.candidate.json --run-id ddv1-m3-canary-YYYYMMDD --output /tmp/howa-ddv1-control/m3-canary --trial ddv1-01-porcelain-parser ddv1-08-protected-exclusion ddv1-11-bounded-implementation
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/mimo-v2.5-pro-direct.candidate.json --run-id ddv1-mimo-canary-YYYYMMDD --output /tmp/howa-ddv1-control/mimo-canary --trial ddv1-01-porcelain-parser ddv1-08-protected-exclusion ddv1-11-bounded-implementation
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/gpt-5.6-luna-max-codex.candidate.json --run-id ddv1-luna-canary-YYYYMMDD --output /tmp/howa-ddv1-control/luna-canary --trial ddv1-01-porcelain-parser ddv1-08-protected-exclusion ddv1-11-bounded-implementation
```

The full campaign remains a later, separately authorized operation:

```bash
cd /tmp/howa-hermes-daily-driver-v1
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/minimax-m3-direct.candidate.json --run-id ddv1-m3-YYYYMMDD --output /tmp/howa-ddv1-control/m3
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/mimo-v2.5-pro-direct.candidate.json --run-id ddv1-mimo-YYYYMMDD --output /tmp/howa-ddv1-control/mimo
pnpm cli -- daily-driver run --candidate campaigns/hermes-daily-driver-v1/gpt-5.6-luna-max-codex.candidate.json --run-id ddv1-luna-YYYYMMDD --output /tmp/howa-ddv1-control/luna
```
