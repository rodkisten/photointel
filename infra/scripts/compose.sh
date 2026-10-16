#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${PHOTOINTEL_COMPOSE_MODE:-dev}"
case "$mode" in dev|prod) ;; *) printf 'Modo Compose inválido.\n' >&2; exit 2;; esac
cd "$repo_dir"
# Keep Compose's BuildKit path as the portable default. Bake requires an extra
# filesystem entitlement for the explicitly configured CA outside this context.
# The CA still enters builds through a read-only BuildKit secret; TLS stays on.
export COMPOSE_BAKE="${COMPOSE_BAKE:-false}"
exec docker compose --env-file .env -f "infra/docker/compose.$mode.yml" "$@"
