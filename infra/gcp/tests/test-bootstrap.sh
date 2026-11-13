#!/usr/bin/env bash
# Offline bootstrap contract tests. No actual Google Cloud access or cost.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/gcloud" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$GCLOUD_TRACE"
# Simulate existing conditional IAM bindings at any scope. Noninteractive
# gcloud refuses unconditional grants unless --condition=None is explicit.
if [[ " $* " == *" add-iam-policy-binding "* && " $* " != *" --condition=None "* ]]; then
  echo "Adding a binding without specifying a condition to a policy containing conditions is prohibited in non-interactive mode." >&2
  exit 1
fi
if [[ "${FAKE_FCM_IAM_DENIED:-false}" == true && "$*" == *"projects add-iam-policy-binding photointel"* && "$*" == *"--role=roles/firebasecloudmessaging.admin"* ]]; then
  echo 'PERMISSION_DENIED: FCM send role grant denied' >&2
  exit 1
fi
case "$*" in
  "iam workload-identity-pools providers describe "*)
    if [[ "${FAKE_WIF_DENIED:-false}" == true ]]; then echo 'PERMISSION_DENIED: WIF access denied' >&2; exit 1; fi
    if [[ "${FAKE_WIF_CURRENT:-false}" == true ]]; then printf '%s\n' "$EXPECTED_WIF_CONDITION"; fi
    exit 0 ;;
  "auth list"*) echo fake-admin@testing.invalid; exit 0 ;;
  "services list"*)
    printf '%s\n' compute.googleapis.com bigquery.googleapis.com run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com logging.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
    if [[ "${FAKE_FCM_ENABLED:-false}" == true ]]; then printf '%s\n' fcm.googleapis.com; fi
    exit 0 ;;
  "artifacts repositories describe "*"--format=value(format)"*) echo DOCKER; exit 0 ;;
  "storage buckets describe "*"--format=value(location)"*) echo US; exit 0 ;;
  "iam roles describe "*)
    if [[ "${FAKE_CREATOR_ROLE_MISSING:-false}" == true ]]; then echo "NOT_FOUND: creator role does not exist" >&2; exit 1; fi
    exit 0 ;;
  "iam service-accounts describe "*)
    if [[ "${FAKE_PERMISSION_DENIED:-false}" == true ]]; then echo 'PERMISSION_DENIED: Permission denied' >&2; exit 1; fi
    if [[ "${FAKE_MANAGE_MISSING:-false}" == true && "$*" == *"photointel-manage@"* ]]; then
      echo 'NOT_FOUND: Manage service account does not exist' >&2; exit 1
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod 700 "$TMP/gcloud"
export PATH="$TMP:$PATH" GCLOUD_TRACE="$TMP/trace"
export GCP_CONFIG_FILE="$ROOT/infra/gcp/config.example.json" CONFIRM_PROJECT=replace-project-id
export EXPECTED_WIF_CONDITION="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production' && assertion.workflow_ref in ['rodkisten/photointel/.github/workflows/gcp-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/gcp-terminal.yml@refs/heads/main','rodkisten/photointel/.github/workflows/tf-state-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/tf-production.yml@refs/heads/main']"
: > "$GCLOUD_TRACE"
BOOTSTRAP_MODE=plan bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/plan"
if grep -Eq '(^| )create | add-iam-policy-binding | services enable ' "$GCLOUD_TRACE"; then
  echo "ERROR: plan mutated resources" >&2; exit 1
fi
for attempt in 1 2; do
  : > "$GCLOUD_TRACE"
  BOOTSTRAP_MODE=apply AUTHORIZE_CHARGES=true bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/attempt-$attempt"
  if grep -Eq 'artifacts repositories create|iam service-accounts create|secrets create|storage buckets create|services enable' "$GCLOUD_TRACE"; then
    echo "ERROR: existing resources were recreated" >&2; exit 1
  fi
  grep -Fq -- "--attribute-condition=$EXPECTED_WIF_CONDITION" "$GCLOUD_TRACE"
  grep -q 'iam service-accounts add-iam-policy-binding' "$GCLOUD_TRACE"
  for role in roles/run.viewer roles/logging.viewer roles/cloudscheduler.viewer \
    roles/bigquery.jobUser roles/bigquery.dataViewer projects/replace-project-id/roles/photointelManageInfrastructure \
    roles/secretmanager.viewer roles/secretmanager.secretAccessor \
    roles/secretmanager.secretVersionAdder projects/replace-project-id/roles/photointelManageSecretCreator; do
    grep -F "projects add-iam-policy-binding replace-project-id" "$GCLOUD_TRACE" |
      grep -F -- "--member=serviceAccount:photointel-manage@replace-project-id.iam.gserviceaccount.com" |
      grep -Fq -- "--role=$role"
  done
  if grep -F "projects add-iam-policy-binding" "$GCLOUD_TRACE" |
      grep -F "photointel-manage@" |
      grep -Ev -- "--role=(roles/(run.viewer|logging.viewer|cloudscheduler.viewer|bigquery.jobUser|bigquery.dataViewer|secretmanager.viewer|secretmanager.secretAccessor|secretmanager.secretVersionAdder)|projects/replace-project-id/roles/photointelManage(SecretCreator|Infrastructure))" >/dev/null; then
    echo "ERROR: Manage service account received an unexpected IAM role" >&2; exit 1
  fi
  for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin roles/iam.roleAdmin; do
    grep -F -- "--role=$role" "$GCLOUD_TRACE" | grep -q -- '--member=serviceAccount:photointel-bootstrap@'
  done
  grep -q 'projects add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'secrets add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'storage buckets add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'artifacts repositories add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  # The terminal's build action authenticates as bootstrap, not deployer.
  # The permission must be scoped to the Docker repository, never the project.
  grep -F 'artifacts repositories add-iam-policy-binding photointel --location=us-central1' "$GCLOUD_TRACE" |
    grep -F -- '--member=serviceAccount:photointel-bootstrap@replace-project-id.iam.gserviceaccount.com' |
    grep -F -- '--role=roles/artifactregistry.writer' |
    grep -qF -- '--condition=None'
  if grep -F 'projects add-iam-policy-binding' "$GCLOUD_TRACE" |
    grep -Fq -- '--member=serviceAccount:photointel-bootstrap@replace-project-id.iam.gserviceaccount.com --role=roles/artifactregistry.writer'; then
    echo "ERROR: bootstrap Artifact Registry writer role was project-wide" >&2; exit 1
  fi
  grep -q 'iam service-accounts add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
done
: > "$GCLOUD_TRACE"
if FAKE_PERMISSION_DENIED=true BOOTSTRAP_MODE=apply AUTHORIZE_CHARGES=true bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/denied" 2>&1; then
  echo "ERROR: permission denial was ignored" >&2; exit 1
fi
if grep -q 'iam service-accounts create' "$GCLOUD_TRACE"; then
  echo "ERROR: attempted create after a permission denial" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
FAKE_WIF_CURRENT=true BOOTSTRAP_MODE=apply AUTHORIZE_CHARGES=true bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/wif-current"
if grep -q 'providers update-oidc' "$GCLOUD_TRACE"; then
  echo "ERROR: matching WIF condition was unnecessarily updated" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
if FAKE_WIF_DENIED=true BOOTSTRAP_MODE=apply AUTHORIZE_CHARGES=true bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/wif-denied" 2>&1; then
  echo "ERROR: WIF permission denial was ignored" >&2; exit 1
fi
if grep -q 'providers update-oidc' "$GCLOUD_TRACE"; then
  echo "ERROR: attempted WIF update after permission denial" >&2; exit 1
fi
# Targeted IAM repair may create only the Manage SA; other resources stay unchanged.
jq '.secrets.SENTRY_DSN = {"name":"photointel-sentry-dsn","version":"1"} |
    .secrets.SENTRY_API_TOKEN = {"name":"photointel-sentry-api-token","version":"1"} |
    .workflow_secrets.SENTRY_AUTH_TOKEN = {"name":"photointel-sentry-build-token","version":"1"}' \
    "$ROOT/infra/gcp/config.example.json" > "$TMP/config-sentry.json"
: > "$GCLOUD_TRACE"
GCP_CONFIG_FILE="$TMP/config-sentry.json" BOOTSTRAP_MODE=permissions \
    bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/permissions"
# Terraform owns API/processing secret grants; bootstrap must not compete.
if grep -F 'secrets add-iam-policy-binding' "$GCLOUD_TRACE" |
    grep -Eq -- '--member=serviceAccount:photointel-(api|jobs)@'; then
    echo "ERROR: bootstrap mutated Terraform-owned runtime secret IAM" >&2; exit 1
fi
grep -F 'secrets add-iam-policy-binding photointel-sentry-build-token' "$GCLOUD_TRACE" |
    grep -Fq 'photointel-deployer@replace-project-id.iam.gserviceaccount.com'
grep -F 'projects add-iam-policy-binding replace-project-id' "$GCLOUD_TRACE" |
    grep -F -- '--member=serviceAccount:photointel-api@replace-project-id.iam.gserviceaccount.com' |
    grep -Fq -- '--role=roles/logging.viewer'
# IAM repair retains the existing, narrowly scoped builder actAs grant.
grep -F 'iam service-accounts add-iam-policy-binding photointel-builder@replace-project-id.iam.gserviceaccount.com' "$GCLOUD_TRACE" |
    grep -F -- '--member=serviceAccount:photointel-deployer@replace-project-id.iam.gserviceaccount.com' |
    grep -Fq -- '--role=roles/iam.serviceAccountUser --condition=None'
if grep -Ev '^iam service-accounts add-iam-policy-binding photointel-builder@replace-project-id\.iam\.gserviceaccount\.com ' "$GCLOUD_TRACE" |
    grep -Eq 'services enable|artifacts |storage |iam service-accounts (add-iam-policy-binding|create)|secrets create|providers update-oidc'; then
    echo "ERROR: IAM-only mode attempted broader provisioning" >&2; exit 1
fi
for role in roles/run.viewer roles/logging.viewer roles/cloudscheduler.viewer \
    roles/bigquery.jobUser roles/bigquery.dataViewer projects/replace-project-id/roles/photointelManageInfrastructure \
    roles/secretmanager.viewer roles/secretmanager.secretAccessor \
    roles/secretmanager.secretVersionAdder projects/replace-project-id/roles/photointelManageSecretCreator; do
  grep -F "projects add-iam-policy-binding replace-project-id" "$GCLOUD_TRACE" |
    grep -Fq -- "--member=serviceAccount:photointel-manage@replace-project-id.iam.gserviceaccount.com --role=$role"
done
if [[ "$(grep -c 'projects add-iam-policy-binding' "$GCLOUD_TRACE")" != 13 ]]; then
  echo "ERROR: IAM-only mode changed unexpected project policies" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
FAKE_MANAGE_MISSING=true GCP_CONFIG_FILE="$TMP/config-sentry.json" BOOTSTRAP_MODE=permissions \
  bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/manage-missing"
grep -F "iam service-accounts create photointel-manage" "$GCLOUD_TRACE" |
  grep -Fq -- "--display-name=PhotoIntel Manage (Access protected admin)"
: > "$GCLOUD_TRACE"
FAKE_CREATOR_ROLE_MISSING=true GCP_CONFIG_FILE="$TMP/config-sentry.json" BOOTSTRAP_MODE=permissions \
  bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/creator-missing"
grep -F "iam roles create photointelManageSecretCreator" "$GCLOUD_TRACE" |
  grep -Fq -- "--permissions=secretmanager.secrets.create"
if grep -F "iam roles create photointelManageSecretCreator" "$GCLOUD_TRACE" |
   grep -E -- "--permissions=[^ ]*(delete|destroy|setIamPolicy|versions.access)" >/dev/null; then
  echo "ERROR: custom Manage creator role is overprivileged" >&2; exit 1
fi
if grep -F "iam service-accounts create " "$GCLOUD_TRACE" | grep -v "photointel-manage" >/dev/null; then
  echo "ERROR: IAM-only mode created unrelated service accounts" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
if FAKE_PERMISSION_DENIED=true BOOTSTRAP_MODE=permissions bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/manage-denied" 2>&1; then
  echo "ERROR: IAM-only mode suppressed SA permission denied" >&2; exit 1
fi
if grep -q "iam service-accounts create" "$GCLOUD_TRACE"; then
  echo "ERROR: IAM-only mode created SA after inspection failed" >&2; exit 1
fi
# FCM lives in the SAME GCP project as API/jobs. No cross-project grant,
# extra API enablement, or unrelated permissions should be attempted.
jq '.project_id = "photointel" |
    .extra_environment.FCM_PROJECT_ID = "photointel" |
    .extra_environment.FCM_JOB_EVENTS_ENABLED = "true"' \
    "$ROOT/infra/gcp/config.example.json" > "$TMP/config-fcm.json"
: > "$GCLOUD_TRACE"
CONFIRM_PROJECT=photointel GCP_CONFIG_FILE="$TMP/config-fcm.json" BOOTSTRAP_MODE=permissions \
  bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/fcm-permissions"
if [[ "$(grep -Fc 'services enable fcm.googleapis.com --project=photointel' "$GCLOUD_TRACE")" != 1 ]]; then
  echo "ERROR: FCM API must be enabled exactly once in photointel" >&2; exit 1
fi
if grep -F 'services enable fcm.googleapis.com' "$GCLOUD_TRACE" | grep -vF -- '--project=photointel' >/dev/null; then
  echo "ERROR: FCM API enabled in an unexpected project" >&2; exit 1
fi
for account in api jobs; do
  grep -F 'projects add-iam-policy-binding photointel' "$GCLOUD_TRACE" |
    grep -F -- "--member=serviceAccount:photointel-$account@photointel.iam.gserviceaccount.com" |
    grep -F -- '--role=roles/firebasecloudmessaging.admin' |
    grep -Fq -- '--condition=None'
done
if [[ "$(grep -Fc -- '--role=roles/firebasecloudmessaging.admin' "$GCLOUD_TRACE")" != 2 ]]; then
  echo "ERROR: FCM must grant only api and jobs" >&2; exit 1
fi
if grep -F 'roles/firebasecloudmessaging.admin' "$GCLOUD_TRACE" |
   grep -vF 'projects add-iam-policy-binding photointel ' >/dev/null; then
  echo "ERROR: FCM IAM grant targeted another GCP project" >&2; exit 1
fi
if grep -E 'services enable|artifacts |storage |secrets create|providers update-oidc' "$GCLOUD_TRACE" |
    grep -vF 'services enable fcm.googleapis.com' >/dev/null; then
  echo "ERROR: FCM permissions mode provisioned unrelated infrastructure" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
FAKE_FCM_ENABLED=true CONFIRM_PROJECT=photointel GCP_CONFIG_FILE="$TMP/config-fcm.json" BOOTSTRAP_MODE=permissions \
  bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/fcm-already-enabled"
if grep -Fq 'services enable fcm.googleapis.com' "$GCLOUD_TRACE"; then
  echo "ERROR: already-enabled FCM API unnecessarily enabled again" >&2; exit 1
fi
: > "$GCLOUD_TRACE"
if FAKE_FCM_IAM_DENIED=true CONFIRM_PROJECT=photointel GCP_CONFIG_FILE="$TMP/config-fcm.json" \
  BOOTSTRAP_MODE=permissions bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/fcm-denied" 2>&1; then
  echo "ERROR: FCM project IAM permission denial ignored" >&2; exit 1
fi
grep -Fq 'resourcemanager.projects.setIamPolicy' "$TMP/fcm-denied"
: > "$GCLOUD_TRACE"
CONFIRM_PROJECT=photointel GCP_CONFIG_FILE="$TMP/config-fcm.json" \
  BOOTSTRAP_MODE=plan bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/fcm-plan"
grep -Fq 'PLAN: FCM API and api/jobs FCM send role in photointel only' "$TMP/fcm-plan"
if grep -Fq 'services enable fcm.googleapis.com' "$GCLOUD_TRACE"; then
  echo "ERROR: Firebase plan mode mutated services" >&2; exit 1
fi
jq '.extra_environment.FCM_PROJECT_ID = "photointel-firebase"' "$TMP/config-fcm.json" > "$TMP/fcm-wrong-target.json"
if CONFIRM_PROJECT=photointel GCP_CONFIG_FILE="$TMP/fcm-wrong-target.json" BOOTSTRAP_MODE=permissions \
  bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/fcm-wrong-target" 2>&1; then
  echo "ERROR: unapproved cross-project FCM target was accepted" >&2; exit 1
fi
grep -Fq 'FCM_PROJECT_ID must match GCP project_id (photointel)' "$TMP/fcm-wrong-target"
echo "Bootstrap offline tests passed: plan, idempotence, Manage IAM, FCM same-project API/IAM and denial."
