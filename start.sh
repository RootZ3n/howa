#!/usr/bin/env bash
# Howa launch wrapper.
# Ensures the build is fresh, the state directory exists, and env is propagated
# from .env (if present).
#
# HOWA_* env vars are the canonical names; COLOSSEUM_* names are honored
# for backward compatibility with v0.1 deployments installed before the
# Colosseum → Howa rename.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_ROOT="${HOWA_STATE_ROOT:-${COLOSSEUM_STATE_ROOT:-${COLOSSEUM_STATE:-}}}"
PORT="${HOWA_PORT:-${COLOSSEUM_PORT:-18799}}"
HOST="${HOWA_HOST:-${COLOSSEUM_HOST:-127.0.0.1}}"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'

# ── helpers ──────────────────────────────────────────────────────────────────
info()  { printf "${GREEN}[start]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[start]${RESET} %s\n" "$*" >&2; }
die()   { printf "${RED}[start]${RESET} %s\n" "$*" >&2; exit 1; }

# ── .env bootstrap ───────────────────────────────────────────────────────────
if [[ -f "${REPO_ROOT}/.env" ]]; then
  info "sourcing .env ..."
  set -o allexport
  # Shellcheck can't follow what dotenv does — tell it to back off.
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +o allexport
fi

# ── build check ───────────────────────────────────────────────────────────────
if [[ ! -d "${REPO_ROOT}/dist" ]]; then
  info "dist/ missing — running npm run build ..."
  cd "${REPO_ROOT}"
  npm run build
fi

# ── port availability ─────────────────────────────────────────────────────────
if ! command -v ss &>/dev/null && ! command -v netstat &>/dev/null; then
  warn "ss/netstat not found — cannot verify port ${PORT} is free"
elif ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  warn "port ${PORT} appears to be in use — will attempt to start anyway"
fi

# ── launch ───────────────────────────────────────────────────────────────────
info "starting Howa on http://${HOST}:${PORT}"
info "state root: ${STATE_ROOT:-default (colosseum-state/)}"

cd "${REPO_ROOT}"
exec node dist/api/server.js
