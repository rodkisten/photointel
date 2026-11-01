#!/usr/bin/env bash
# Administrative, idempotent provisioning. All remote mutations use gcloud.
set -Eeuo pipefail
MODE="${BOOTSTRAP_MODE:-plan}"
CONFIG="${GCP_CONFIG_FILE:-infra/gcp/config.local.json}"
[[ "$MODE" == "plan" || "$MODE" == "apply" || "$MODE" == "permissions" ]] || { echo "::error::Invalid mode" >&2; exit 2; }
command -v jq >/dev/null || { echo "::error::jq is required" >&2; exit 2; }
if [[ "$MODE" != plan ]]; then command -v gcloud >/dev/null || { echo "::error::gcloud is required for IAM/apply" >&2; exit 2; }; fi
PROJECT="$(jq -er '.project_id' "$CONFIG")"
REGION="$(jq -er '.region' "$CONFIG")"
REPO="$(jq -er '.repository' "$CONFIG")"
[[ "$PROJECT" == "${CONFIRM_PROJECT:-}" ]] || { echo "::error::Project mismatch" >&2; exit 2; }
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ && "$REGION" =~ ^[a-z]+-[a-z]+[0-9]$ && "$REPO" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] || exit 2
if [[ "$MODE" == "apply" && "${AUTHORIZE_CHARGES:-false}" != "true" ]]; then echo "::error::Apply requires charge authorization" >&2; exit 2; fi
BUCKET="gs://$PROJECT-photointel-build-source"
BUILDER="serviceAccount:photointel-builder@$PROJECT.iam.gserviceaccount.com"
DEPLOYER="serviceAccount:photointel-deployer@$PROJECT.iam.gserviceaccount.com"
# The Terminal build runs as this administrative WIF identity (not deployer).
BOOTSTRAP="serviceAccount:photointel-bootstrap@$PROJECT.iam.gserviceaccount.com"
APIS=(run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com logging.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com)
log() { printf '[bootstrap] %s\n' "$*"; }
gcp() { gcloud "$@" "--project=$PROJECT" --quiet; }
change() { if [[ "$MODE" != "plan" ]]; then gcp "$@"; else log "PLAN gcloud $* --project=$PROJECT"; fi; }
# Return 0=exists, 1=missing, 2=other error; never confuse IAM denial with absence.
exists() {
  local err; err="$(mktemp)"
  if gcp "$@" > /dev/null 2>"$err"; then rm -f "$err"; return 0; fi
  if grep -Eqi 'PERMISSION_DENIED|permission denied|does not have permission|forbidden|UNAUTHENTICATED|not authorized' "$err"; then
    cat "$err" >&2; rm -f "$err"; return 2
  fi
  if grep -Eqi 'NOT_FOUND|not found|does not exist|404' "$err"; then rm -f "$err"; return 1; fi
  cat "$err" >&2; rm -f "$err"; return 2
}
ensure() {
  local label="$1"; shift
  local -a query=() create=()
  local mode=query arg rc
  for arg in "$@"; do
    if [[ "$arg" == '@@CREATE@@' ]]; then mode=create; continue; fi
    if [[ "$mode" == query ]]; then query+=("$arg"); else create+=("$arg"); fi
  done
  if exists "${query[@]}"; then log "EXISTS: $label"; return 0; else rc=$?; fi
  if [[ "$rc" != 1 ]]; then echo "::error::Cannot inspect $label; refusing to create" >&2; return 1; fi
  log "MISSING: $label"
  change "${create[@]}"
}
jq -e '.secrets | type == "object"' "$CONFIG" >/dev/null
mapfile -t KEYS < <(jq -r '.secrets | keys[]' "$CONFIG")
declare -A SECRET_NAMES
for key in "${KEYS[@]}"; do
  name="$(jq -er --arg k "$key" '.secrets[$k].name' "$CONFIG")"
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,254}$ ]] || exit 2
  SECRET_NAMES["$key"]="$name"
done
# Workflow-only secrets are never granted to API, worker or migration identities.
WORKFLOW_COUNT="$(jq -r '(.workflow_secrets // {}) | length' "$CONFIG")"
declare -A WORKFLOW_NAMES
while IFS= read -r key; do
  [[ -z "$key" ]] && continue
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || exit 2
  name="$(jq -er --arg k "$key" '.workflow_secrets[$k].name' "$CONFIG")"
  [[ "$name" =~ ^[a-z][a-z0-9-]{0,254}$ ]] || exit 2
  WORKFLOW_NAMES["$key"]="$name"
done < <(jq -r '(.workflow_secrets // {}) | keys[]' "$CONFIG")
reconcile_secret_access() {
  for key in "${KEYS[@]}"; do
    name="${SECRET_NAMES[$key]}"
    for role in api jobs migrate; do
      case "$role:$key" in
        api:MIGRATION_DATABASE_URL|api:ICLOUD_SESSION_KEY|jobs:MIGRATION_DATABASE_URL|jobs:SENTRY_API_TOKEN) continue ;;
        migrate:*) if [[ "$key" != DATABASE_URL && "$key" != MIGRATION_DATABASE_URL ]]; then continue; fi ;;
      esac
      change secrets add-iam-policy-binding "$name" "--member=serviceAccount:photointel-$role@$PROJECT.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --condition=None --format=none
    done
  done
  for key in "${!WORKFLOW_NAMES[@]}"; do
    change secrets add-iam-policy-binding "${WORKFLOW_NAMES[$key]}" "--member=$DEPLOYER" --role=roles/secretmanager.secretAccessor --condition=None --format=none
  done
}
reconcile_diagnostics_access() {
  # Authenticated read-only incident inspector. Logs are filtered/sanitized in API.
  change projects add-iam-policy-binding "$PROJECT" \
    "--member=serviceAccount:photointel-api@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/logging.viewer --condition=None --format=none
}
log "Project=$PROJECT Region=$REGION Repository=$REPO Mode=$MODE"
if [[ "$MODE" == permissions ]]; then
  # Only add narrowly scoped secret IAM bindings. Do not provision infrastructure,
  # change workload identity providers, build images or touch database schemas.
  reconcile_secret_access
  reconcile_diagnostics_access
  log "✅ Secret Manager + read-only Cloud Logging IAM reconciled; no resources created."
  exit 0
fi
if [[ "$MODE" != plan ]]; then log "Active identity: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' --quiet)"; fi
if [[ "$MODE" == plan ]]; then
  log "No mutations. Will reconcile APIs, Docker repository, six service accounts, $((${#KEYS[@]} + WORKFLOW_COUNT)) secret containers, staging bucket, IAM, and bootstrap WIF condition (bootstrap + terminal only)."
  exit 0
fi
enabled="$(gcp services list --enabled --format='value(config.name)')"
missing=()
for api in "${APIS[@]}"; do if ! grep -Fxq "$api" <<< "$enabled"; then missing+=("$api"); fi; done
if (("${#missing[@]}" > 0)); then change services enable "${missing[@]}"; else log "APIs already enabled"; fi
# Reconcile the existing privileged provider; leave the normal deploy provider intact.
# Initial provider creation and permission to manage WIF remain administrator setup.
BOOTSTRAP_WIF_CONDITION="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production' && assertion.workflow_ref in ['rodkisten/photointel/.github/workflows/gcp-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/gcp-terminal.yml@refs/heads/main']"
current_condition="$(gcp iam workload-identity-pools providers describe photo-intelligence-bootstrap --location=global --workload-identity-pool=github-bootstrap --format='value(attributeCondition)')"
if [[ "$current_condition" != "$BOOTSTRAP_WIF_CONDITION" ]]; then
  change iam workload-identity-pools providers update-oidc photo-intelligence-bootstrap --location=global --workload-identity-pool=github-bootstrap "--attribute-condition=$BOOTSTRAP_WIF_CONDITION"
else
  log "Bootstrap WIF condition already reconciled"
fi
# The privileged bootstrap provisions the terminal VM and its firewall/custom role.
# Keep these privileges off the normal deployer and runtime identities.
for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin roles/iam.roleAdmin; do
  change projects add-iam-policy-binding "$PROJECT" "--member=serviceAccount:photointel-bootstrap@$PROJECT.iam.gserviceaccount.com" "--role=$role" --condition=None --format=none
done
ensure "Docker repository $REPO" artifacts repositories describe "$REPO" "--location=$REGION" @@CREATE@@ artifacts repositories create "$REPO" "--location=$REGION" --repository-format=docker "--description=Private PhotoIntel images"
format="$(gcp artifacts repositories describe "$REPO" "--location=$REGION" --format='value(format)')"
[[ "$format" == DOCKER ]] || { echo "::error::Repository is not Docker: $format" >&2; exit 1; }
for role in api jobs migrate scheduler builder deployer; do
  id="photointel-$role"; email="$id@$PROJECT.iam.gserviceaccount.com"
  ensure "Service account $email" iam service-accounts describe "$email" @@CREATE@@ iam service-accounts create "$id" "--display-name=PhotoIntel $role"
done
for key in "${KEYS[@]}"; do
  name="${SECRET_NAMES[$key]}"
  ensure "Secret container $name" secrets describe "$name" @@CREATE@@ secrets create "$name" --replication-policy=automatic
done
for key in "${!WORKFLOW_NAMES[@]}"; do
  ensure "Workflow secret container ${WORKFLOW_NAMES[$key]}" secrets describe "${WORKFLOW_NAMES[$key]}" @@CREATE@@ secrets create "${WORKFLOW_NAMES[$key]}" --replication-policy=automatic
done
ensure "Staging bucket $BUCKET" storage buckets describe "$BUCKET" @@CREATE@@ storage buckets create "$BUCKET" "--location=$REGION" --uniform-bucket-level-access --public-access-prevention
log "Staging bucket location: $(gcp storage buckets describe "$BUCKET" --format='value(location)'); no relocation"
reconcile_secret_access
reconcile_diagnostics_access
# The terminal bootstrap preflight checks OAuth version existence/state without
# ever reading credential payloads. Metadata-only viewer is scoped to these
# two secret containers and is distinct from secretAccessor.
for key in TS_OAUTH_CLIENT_ID TS_OAUTH_SECRET; do
  if [[ -n "${WORKFLOW_NAMES[$key]:-}" ]]; then
    change secrets add-iam-policy-binding "${WORKFLOW_NAMES[$key]}" "--member=$BOOTSTRAP" --role=roles/secretmanager.viewer --condition=None --format=none
  fi
done
change storage buckets add-iam-policy-binding "$BUCKET" "--member=$BUILDER" --role=roles/storage.objectViewer --condition=None --format=none
change artifacts repositories add-iam-policy-binding "$REPO" "--location=$REGION" "--member=$BUILDER" --role=roles/artifactregistry.writer --condition=None --format=none
# Docker push can succeed while image describe/tagging fails without registry read.
# Limit bootstrap's Terminal image build/pinning permission to this repository only.
change artifacts repositories add-iam-policy-binding "$REPO" "--location=$REGION" "--member=$BOOTSTRAP" --role=roles/artifactregistry.writer --condition=None --format=none
change projects add-iam-policy-binding "$PROJECT" "--member=$BUILDER" --role=roles/logging.logWriter --condition=None --format=none
for role in roles/run.admin roles/cloudscheduler.admin roles/cloudbuild.builds.editor roles/artifactregistry.reader roles/logging.viewer roles/serviceusage.serviceUsageConsumer; do
  change projects add-iam-policy-binding "$PROJECT" "--member=$DEPLOYER" "--role=$role" --condition=None --format=none
done
change storage buckets add-iam-policy-binding "$BUCKET" "--member=$DEPLOYER" --role=roles/storage.objectAdmin --condition=None --format=none
for role in api jobs migrate scheduler builder; do
  change iam service-accounts add-iam-policy-binding "photointel-$role@$PROJECT.iam.gserviceaccount.com" "--member=$DEPLOYER" --role=roles/iam.serviceAccountUser --condition=None --format=none
done
# The WIF deployer may obtain a short-lived migration identity token, but it
# does NOT receive project-wide or direct Secret Manager reader permissions.
change iam service-accounts add-iam-policy-binding "photointel-migrate@$PROJECT.iam.gserviceaccount.com" "--member=$DEPLOYER" --role=roles/iam.serviceAccountTokenCreator --condition=None --format=none
log "Completed: no resources deleted and no secret values created."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '### Bootstrap GCP completed\n\n- Project: %s\n- Repository: %s (%s)\n- Service accounts: 6\n- Secret containers: %s\n' "$PROJECT" "$REPO" "$REGION" "$((${#KEYS[@]} + WORKFLOW_COUNT))" >> "$GITHUB_STEP_SUMMARY"
fi

