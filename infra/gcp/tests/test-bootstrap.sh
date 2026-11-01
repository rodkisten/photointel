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
case "$*" in
  "iam workload-identity-pools providers describe "*)
    if [[ "${FAKE_WIF_DENIED:-false}" == true ]]; then echo 'PERMISSION_DENIED: WIF access denied' >&2; exit 1; fi
    if [[ "${FAKE_WIF_CURRENT:-false}" == true ]]; then printf '%s\n' "$EXPECTED_WIF_CONDITION"; fi
    exit 0 ;;
  "auth list"*) echo fake-admin@testing.invalid; exit 0 ;;
  "services list"*)
    printf '%s\n' run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com logging.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
    exit 0 ;;
  "artifacts repositories describe "*"--format=value(format)"*) echo DOCKER; exit 0 ;;
  "storage buckets describe "*"--format=value(location)"*) echo US; exit 0 ;;
  "iam service-accounts describe "*)
    if [[ "${FAKE_PERMISSION_DENIED:-false}" == true ]]; then echo 'PERMISSION_DENIED: Permission denied' >&2; exit 1; fi
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod 700 "$TMP/gcloud"
export PATH="$TMP:$PATH" GCLOUD_TRACE="$TMP/trace"
export GCP_CONFIG_FILE="$ROOT/infra/gcp/config.example.json" CONFIRM_PROJECT=replace-project-id
export EXPECTED_WIF_CONDITION="assertion.repository=='rodkisten/photointel' && assertion.ref=='refs/heads/main' && assertion.environment=='production' && assertion.workflow_ref in ['rodkisten/photointel/.github/workflows/gcp-bootstrap.yml@refs/heads/main','rodkisten/photointel/.github/workflows/gcp-terminal.yml@refs/heads/main']"
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
# Targeted IAM repair must update only secret-level bindings; no provisioning.
jq '.secrets.SENTRY_DSN = {"name":"photointel-sentry-dsn","version":"1"} |
    .secrets.SENTRY_API_TOKEN = {"name":"photointel-sentry-api-token","version":"1"} |
    .workflow_secrets.SENTRY_AUTH_TOKEN = {"name":"photointel-sentry-build-token","version":"1"}' \
    "$ROOT/infra/gcp/config.example.json" > "$TMP/config-sentry.json"
: > "$GCLOUD_TRACE"
GCP_CONFIG_FILE="$TMP/config-sentry.json" BOOTSTRAP_MODE=permissions \
    bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/permissions"
grep -F 'secrets add-iam-policy-binding photointel-sentry-dsn' "$GCLOUD_TRACE" |
    grep -F 'photointel-jobs@replace-project-id.iam.gserviceaccount.com' |
    grep -Fq 'roles/secretmanager.secretAccessor'
grep -F 'secrets add-iam-policy-binding photointel-sentry-api-token' "$GCLOUD_TRACE" |
    grep -Fq 'photointel-api@replace-project-id.iam.gserviceaccount.com'
if grep -F 'secrets add-iam-policy-binding photointel-sentry-api-token' "$GCLOUD_TRACE" |
    grep -Fq 'photointel-jobs@'; then
    echo "ERROR: private Sentry API token granted to worker identity" >&2; exit 1
fi
grep -F 'secrets add-iam-policy-binding photointel-sentry-build-token' "$GCLOUD_TRACE" |
    grep -Fq 'photointel-deployer@replace-project-id.iam.gserviceaccount.com'
if grep -Eq 'services enable|artifacts |storage |projects |iam service-accounts |secrets create|providers update-oidc' "$GCLOUD_TRACE"; then
    echo "ERROR: IAM-only mode attempted broader provisioning" >&2; exit 1
fi
echo "Bootstrap offline tests passed: plan, idempotence, IAM-only repair and denial."

