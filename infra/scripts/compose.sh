#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${PHOTOINTEL_COMPOSE_MODE:-dev}"
case "$mode" in dev|prod) ;; *) printf 'Modo Compose inválido.\n' >&2; exit 2;; esac
cd "$repo_dir"
exec docker compose --env-file .env -f "infra/docker/compose.$mode.yml" "$@"
