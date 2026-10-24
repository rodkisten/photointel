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
  if [[ "${DATABASE_READY:-false}" != true ]]; then
    log "::error::API publication requires database_ready=true. Verify Neon migration, Secret Manager versions and Cloudflare Access first."
    return 1
  fi
  log "✅ Operator confirmed database migration, Secret Manager and Cloudflare Access readiness."
}

manage() {
  python3 infra/gcp/manage.py "$1" --apply --authorize-charges --confirm-project "$PROJECT"
}

case "$PHASE" in
  gate)
    database_gate
    ;;
  preflight)
    python3 infra/gcp/release_image.py preflight --project "$PROJECT"
    ;;
  cache)
    [[ -n "$SHA" ]] || { log "::error::RELEASE_SHA is required for cache"; exit 2; }
    python3 infra/gcp/release_image.py cache --project "$PROJECT" --sha "$SHA"
    ;;
  verify)
    [[ -n "$SHA" ]] || { log "::error::RELEASE_SHA is required for verify"; exit 2; }
    python3 infra/gcp/release_image.py verify --project "$PROJECT" --sha "$SHA"
    ;;
  build)
    manage build
    summary "✅ Docker image for this exact commit built and verified."
    ;;
  jobs-deploy)
    manage jobs-deploy
    summary "✅ Five Cloud Run Jobs deployed. ⚠️ Database migration has NOT been executed."
    ;;
  deploy)
    database_gate
    manage deploy
    summary "✅ Cloud Run API deployment requested. Test authentication before importing data."
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
    log "Valid phases: gate, preflight, cache, verify, build, jobs-deploy, deploy, scheduler, cleanup"
    exit 2
    ;;
esac
