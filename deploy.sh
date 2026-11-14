#!/usr/bin/env bash
# Deploy to the Vultr box: pull, build the frontend in a throwaway Node container, restart the stack.
# Usage: ./deploy.sh            (reads DEPLOY_HOST / DEPLOY_USER / DEPLOY_PATH from .env or the environment)
# First run on a fresh server: clone the repo to $DEPLOY_PATH and create $DEPLOY_PATH/.env there.
set -euo pipefail

if [ -f .env ]; then
  # only pick up the deploy variables, not secrets
  eval "$(grep -E '^(DEPLOY_HOST|DEPLOY_USER|DEPLOY_PATH)=' .env || true)"
fi
: "${DEPLOY_HOST:?Set DEPLOY_HOST (server IP or domain)}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/wayfinder}"

ssh "${DEPLOY_USER}@${DEPLOY_HOST}" bash -s -- "$DEPLOY_PATH" <<'REMOTE'
set -euo pipefail
cd "$1"
git pull --ff-only
docker run --rm -v "$PWD":/app -w /app node:24-slim sh -c "npm ci --no-audit --no-fund && npm run build"
docker compose up -d --build
docker compose ps
REMOTE

echo "Deployed to ${DEPLOY_HOST}."
