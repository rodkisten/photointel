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
  "auth list"*) echo fake-admin@testing.invalid; exit 0 ;;
  "services list"*)
    printf '%s\n' run.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
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
  grep -q 'iam service-accounts add-iam-policy-binding' "$GCLOUD_TRACE"
  grep -q 'projects add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'secrets add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'storage buckets add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'artifacts repositories add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
  grep -q 'iam service-accounts add-iam-policy-binding .*--condition=None' "$GCLOUD_TRACE"
done
: > "$GCLOUD_TRACE"
if FAKE_PERMISSION_DENIED=true BOOTSTRAP_MODE=apply AUTHORIZE_CHARGES=true bash "$ROOT/infra/gcp/bootstrap.sh" > "$TMP/denied" 2>&1; then
  echo "ERROR: permission denial was ignored" >&2; exit 1
fi
if grep -q 'iam service-accounts create' "$GCLOUD_TRACE"; then
  echo "ERROR: attempted create after a permission denial" >&2; exit 1
fi
echo "Bootstrap offline tests passed: plan, idempotence and IAM denial."
