#!/usr/bin/env bash
# Cloud Run release commands, intentionally kept outside GitHub Actions YAML.
# The workflow controls which phase runs; this script owns the shell behavior.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PHASE="${1:-}"
PROJECT="${CONFIRM_PROJECT:-}"
SHA="${RELEASE_SHA:-}"

[[ -n "$PROJECT" ]] || { echo "::error::CONFIRM_PROJECT is required" >&2; exit 2; }
log() { printf '%s\n' "$*"; }
summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  fi
}

database_gate() {
  # A read-only Neon revision verification replaces the old UI checkbox.
  # Never auto-apply migrations when deploying the API.
  log "🔎 Checking Neon connection and current Alembic revision."
  MIGRATION_MODE=verify bash "$ROOT/infra/gcp/release.sh" migrate
  log "✅ Neon is accessible and the schema matches the checked-out migrations."
}

manage() {
  python3 -m infra.gcp.manage "$1" --apply --authorize-charges --confirm-project "$PROJECT"
}

case "$PHASE" in
  gate)
    database_gate
    ;;
  preflight)
    python3 -m infra.gcp.release_image preflight --project "$PROJECT"
    ;;
  cache)
    [[ -n "$SHA" ]] || { log "::error::RELEASE_SHA is required for cache"; exit 2; }
    python3 -m infra.gcp.release_image cache --project "$PROJECT" --sha "$SHA"
    ;;
  verify)
    [[ -n "$SHA" ]] || { log "::error::RELEASE_SHA is required for verify"; exit 2; }
    python3 -m infra.gcp.release_image verify --project "$PROJECT" --sha "$SHA"
    ;;
  build)
    manage build
    summary "✅ Docker image for this exact commit built and verified."
    ;;
  jobs-deploy)
    python3 -m infra.scripts.cloudflare_setup sync
    python3 -m infra.gcp.manage render
    manage jobs-deploy
    summary "✅ Cloud Run processing Jobs deployed. Neon migrations run separately in GitHub Actions."
    ;;
  migrate)
    mode="${MIGRATION_MODE:-plan}"
    [[ "$mode" == plan || "$mode" == apply || "$mode" == diagnose || "$mode" == verify ]] || { log "::error::Invalid migration mode"; exit 2; }
    # Only Alembic dependencies; no GPU, frontend, API server or ML packages.
    migration_venv="$(mktemp -d "${RUNNER_TEMP:-/tmp}/photointel-neon-XXXXXX")"
    trap 'rm -rf "$migration_venv"' EXIT
    python3 -m venv "$migration_venv"
    "$migration_venv/bin/python" -m pip install --quiet --disable-pip-version-check -r infra/gcp/migration-requirements.txt
    echo "🔎 Checking isolated Python imports, verified TLS and Alembic revisions (offline)."
    "$migration_venv/bin/python" infra/gcp/check_migration_runtime.py
    "$migration_venv/bin/python" -m infra.gcp.migrate_workflow \
      --mode "$mode" \
      --project "$PROJECT" \
      --database "${MIGRATION_DATABASE:-unselected}" \
      --backup-prefix "${MIGRATION_BACKUP_PREFIX:-}"
    ;;
  deploy)
    database_gate
    python3 -m infra.scripts.cloudflare_setup sync
    python3 -m infra.gcp.manage render
    if manage deploy; then
      summary "✅ Cloud Run API deployment requested. Test authentication before importing data."
    else
      status=$?
      log "::error::Cloud Run service deployment failed. Collecting safe startup diagnostics."
      # Do not mask the deployment failure; troubleshooting is read-only and best-effort.
      python3 -m infra.gcp.diagnose_startup --project "$PROJECT" || true
      exit "$status"
    fi
    ;;
  scheduler)
    manage scheduler
    summary "✅ Cloud Scheduler jobs created/updated and paused. Automatic ingestion remains disabled."
    ;;
  cleanup)
    manage cleanup
    summary "✅ Scheduler jobs paused; no databases, images, buckets or services were deleted."
    ;;
  *)
    log "::error::Unknown release phase: $PHASE"
    log "Valid phases: gate, preflight, cache, verify, build, jobs-deploy, migrate, deploy, scheduler, cleanup"
    exit 2
    ;;
esac

