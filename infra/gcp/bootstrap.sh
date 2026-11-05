#!/usr/bin/env bash
# Administrative, idempotent provisioning. All remote mutations use gcloud.
set -Eeuo pipefail
MODE="${BOOTSTRAP_MODE:-plan}"
CONFIG="${GCP_CONFIG_FILE:-infra/gcp/config.local.json}"
[[ "$MODE" == "plan" || "$MODE" == "apply" || "$MODE" == "permissions" ]] || { echo "::error::Invalid mode" >&2; exit 2; }
command -v jq >/dev/null || { echo "::error::jq is required" >&2; exit 2; }
if [[ "$MODE" != plan ]]; then
  command -v gcloud >/dev/null || { echo "::error::gcloud is required for IAM/apply" >&2; exit 2; }
  command -v python3 >/dev/null || { echo "::error::Python3 is required for the shared GCP client" >&2; exit 2; }
fi
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
# Dedicated Access-allowlisted admin identity for the Cloudflare Manage Worker.
MANAGE_ID="photointel-manage"
MANAGE_EMAIL="$MANAGE_ID@$PROJECT.iam.gserviceaccount.com"
MANAGE="serviceAccount:$MANAGE_EMAIL"
# FCM uses this exact GCP project. Never mutate IAM in a second project.
FCM_PROJECT="$(jq -r '.extra_environment.FCM_PROJECT_ID // ""' "$CONFIG")"
FCM_ENABLED="$(jq -r '(.extra_environment.FCM_JOB_EVENTS_ENABLED // "false") | tostring | ascii_downcase' "$CONFIG")"
[[ "$FCM_ENABLED" == true || "$FCM_ENABLED" == false ]] || { echo "::error::FCM_JOB_EVENTS_ENABLED must be true or false" >&2; exit 2; }
if [[ "$FCM_ENABLED" == true && "$FCM_PROJECT" != "$PROJECT" ]]; then
  echo "::error::FCM_PROJECT_ID must match GCP project_id ($PROJECT); refusing cross-project IAM changes" >&2
  exit 2
fi
APIS=(compute.googleapis.com bigquery.googleapis.com run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com logging.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com)
log() { printf '[bootstrap] %s\n' "$*"; }
gcp() { (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && python3 -m infra.gcp.cloud_cli "--project=$PROJECT" -- "$@"); }
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
        api:MIGRATION_DATABASE_URL|jobs:MIGRATION_DATABASE_URL|jobs:SENTRY_API_TOKEN) continue ;;
        migrate:*) if [[ "$key" != DATABASE_URL && "$key" != MIGRATION_DATABASE_URL ]]; then continue; fi ;;
      esac
      change secrets add-iam-policy-binding "$name" "--member=serviceAccount:photointel-$role@$PROJECT.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --condition=None --format=none
    done
  done
  for key in "${!WORKFLOW_NAMES[@]}"; do
    change secrets add-iam-policy-binding "${WORKFLOW_NAMES[$key]}" "--member=$DEPLOYER" --role=roles/secretmanager.secretAccessor --condition=None --format=none
  done
  # Manage WIF bootstrapping discovers ONLY the public Access app AUD using
  # the existing Cloudflare deployment credentials from Secret Manager.
  if [[ -n "$(jq -r '.extra_environment.MANAGE_ACCESS_ALLOWED_EMAILS // ""' "$CONFIG")" ]]; then
    for key in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
      [[ -n "${WORKFLOW_NAMES[$key]:-}" ]] || { echo "::error::Missing $key secret reference for Manage WIF" >&2; return 1; }
      change secrets add-iam-policy-binding "${WORKFLOW_NAMES[$key]}" \
        "--member=$BOOTSTRAP" --role=roles/secretmanager.secretAccessor --condition=None --format=none
    done
  fi
  # Both deploy and bootstrap Actions use the shared Notify action. Give only
  # these two workflow identities access to the relay credential, NOT bot tokens.
  if [[ -n "${SECRET_NAMES[TELEGRAM_NOTIFICATION_API_TOKEN]:-}" ]]; then
    for principal in "$DEPLOYER" "$BOOTSTRAP"; do
      change secrets add-iam-policy-binding "${SECRET_NAMES[TELEGRAM_NOTIFICATION_API_TOKEN]}" \
        "--member=$principal" --role=roles/secretmanager.secretAccessor --condition=None --format=none
    done
  fi
}
reconcile_fcm_permissions() {
  [[ "$FCM_ENABLED" == true ]] || return 0
  # FCM HTTP v1 and the runtime accounts belong to the same GCP project.
  # Enable the API once and grant sending privileges only to api/jobs.
  local enabled_apis account
  if ! enabled_apis="$(gcp services list --enabled "--project=$PROJECT" --format='value(config.name)' --quiet)"; then
    echo "::error::Cannot inspect enabled APIs in $PROJECT. Bootstrap needs serviceusage.services.list." >&2
    return 1
  fi
  if grep -Fxq fcm.googleapis.com <<< "$enabled_apis"; then
    log "EXISTS: Firebase Cloud Messaging API in $PROJECT"
  else
    log "Enabling Firebase Cloud Messaging API in $PROJECT"
    if ! gcp services enable fcm.googleapis.com "--project=$PROJECT" --quiet; then
      echo "::error::Cannot enable FCM API in $PROJECT. Bootstrap needs serviceusage.services.enable." >&2
      return 1
    fi
  fi

  for account in api jobs; do
    log "Reconciling FCM send permission for photointel-$account in $PROJECT"
    if ! gcp projects add-iam-policy-binding "$PROJECT" \
      "--member=serviceAccount:photointel-$account@$PROJECT.iam.gserviceaccount.com" \
      --role=roles/firebasecloudmessaging.admin --condition=None --format=none \
      "--project=$PROJECT" --quiet; then
      echo "::error::Cannot grant FCM role in $PROJECT. Bootstrap service account photointel-bootstrap@$PROJECT.iam.gserviceaccount.com needs resourcemanager.projects.setIamPolicy." >&2
      return 1
    fi
  done
  log "✅ FCM API and project-scoped runtime IAM reconciled."
}

reconcile_diagnostics_access() {
  # Authenticated read-only incident inspector. Logs are filtered/sanitized in API.
  change projects add-iam-policy-binding "$PROJECT" \
    "--member=serviceAccount:photointel-api@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/logging.viewer --condition=None --format=none
}
ensure_manage_identity() {
  # Exists is checked before creation, and auth/permission denial fails closed.
  ensure "Manage service account $MANAGE_EMAIL" \
    iam service-accounts describe "$MANAGE_EMAIL" \
    @@CREATE@@ iam service-accounts create "$MANAGE_ID" \
    "--display-name=PhotoIntel Manage (Access protected admin)"
}
reconcile_manage_federation() {
  # Only configure external federation if a distinct Manage admin allowlist exists.
  if [[ -n "$(jq -r '.extra_environment.MANAGE_ACCESS_ALLOWED_EMAILS // ""' "$CONFIG")" ]]; then
    bash infra/gcp/bootstrap_manage_wif.sh
  fi
}
reconcile_manage_access() {
  # Access-protected administrative editor: metadata for all secrets, value previews
  # and new versions. Never grant Secret Manager Admin/Editor or destructive rights.
  # A custom project role permits only creation of empty secret containers.
  local role_id="photointelManageSecretCreator"
  ensure "Manage secret container creator role" \
    iam roles describe "$role_id" \
    @@CREATE@@ iam roles create "$role_id" \
      "--title=PhotoIntel Manage Secret Creator" \
      "--description=Create secret containers only; no delete or IAM changes" \
      --permissions=secretmanager.secrets.create --stage=GA
  # Read Cloud Build, run allowlisted triggers, and power-cycle only the fixed
  # terminal VM through application-level guards. The IAM permission
  # cloudbuild.builds.create is inherently privileged: protect this SA with
  # dedicated Access WIF and never expose an arbitrary builds.create endpoint.
  local infra_role="photointelManageInfrastructure"
  local infra_permissions="cloudbuild.builds.create,cloudbuild.builds.get,cloudbuild.builds.list,compute.instances.get,compute.instances.getSerialPortOutput,compute.instances.start,compute.instances.stop,compute.instances.setScheduling,compute.zoneOperations.get"
  ensure "Manage infrastructure custom role" \
    iam roles describe "$infra_role" \
    @@CREATE@@ iam roles create "$infra_role" \
      "--title=PhotoIntel Manage infrastructure operations" \
      "--description=Cloud Build trigger execution and limited VM operations" \
      "--permissions=$infra_permissions" --stage=GA
  change projects add-iam-policy-binding "$PROJECT" \
    "--member=$MANAGE" "--role=projects/$PROJECT/roles/$infra_role" --condition=None --format=none
  for role in roles/run.viewer roles/logging.viewer roles/cloudscheduler.viewer \
    roles/bigquery.jobUser roles/bigquery.dataViewer \
    roles/secretmanager.viewer roles/secretmanager.secretAccessor \
    roles/secretmanager.secretVersionAdder "projects/$PROJECT/roles/$role_id"; do
    change projects add-iam-policy-binding "$PROJECT" \
      "--member=$MANAGE" "--role=$role" --condition=None --format=none
  done
}
log "Project=$PROJECT Region=$REGION Repository=$REPO Mode=$MODE"
if [[ "$MODE" == permissions ]]; then
  # IAM repair may create only the dedicated Manage service account if missing.
  # Do not provision general infrastructure, change WIF providers or touch data.
  ensure_manage_identity
  reconcile_secret_access
  reconcile_diagnostics_access
  reconcile_manage_access
  reconcile_manage_federation
  reconcile_fcm_permissions
  log "✅ Runtime IAM, FCM permissions, and Manage federation reconciled."
  exit 0
fi
if [[ "$MODE" != plan ]]; then log "Active identity: $(gcp auth list --filter=status:ACTIVE --format='value(account)' --quiet)"; fi
if [[ "$MODE" == plan ]]; then
  log "No mutations. Will reconcile APIs, Docker repository, seven service accounts (including read-only Manage and its Cloudflare Access WIF federation when configured), $((${#KEYS[@]} + WORKFLOW_COUNT)) secret containers, staging bucket, IAM, and bootstrap WIF condition (bootstrap + terminal only)."
  [[ "$FCM_ENABLED" == true ]] && log "PLAN: FCM API and api/jobs FCM send role in $PROJECT only"
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
for role in api jobs migrate scheduler builder deployer manage; do
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
reconcile_manage_access
reconcile_manage_federation
reconcile_fcm_permissions
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
  printf '### Bootstrap GCP completed\n\n- Project: %s\n- Repository: %s (%s)\n- Service accounts: 7\n- Secret containers: %s\n' "$PROJECT" "$REPO" "$REGION" "$((${#KEYS[@]} + WORKFLOW_COUNT))" >> "$GITHUB_STEP_SUMMARY"
fi

