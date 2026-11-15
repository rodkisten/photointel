#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/ci/pretty-logs.sh
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GITHUB_ACTIONS=true GITHUB_STEP_SUMMARY="$tmp/summary" GITHUB_RUN_ID=123
assert_contains() {
  grep -Fq "$2" "$1" || { printf 'Missing expected text: %s\n' "$2" >&2; exit 1; }
}
test_case() {
  local name="$1" expected="$2" snippet="$3" link="$4" code=0
  : > "$GITHUB_STEP_SUMMARY"
  ci_run "$name" bash -c "printf '%s\\n' '$snippet'; exit 17" >"$tmp/output" 2>&1 || code=$?
  [[ "$code" -eq 17 ]] || { echo "Wrong exit code for $name: $code" >&2; exit 1; }
  assert_contains "$tmp/output" "$snippet"
  assert_contains "$GITHUB_STEP_SUMMARY" "$expected"
  assert_contains "$GITHUB_STEP_SUMMARY" "$link"
  assert_contains "$tmp/output" '::endgroup::'
  echo "PASS: $name"
}
test_case "IAM failure" "Access denied (403)" "PERMISSION_DENIED: 403" "/iam-admin/iam?"
test_case "Missing resource" "Resource not found (404)" "NOT_FOUND: 404" "/home/dashboard?"
test_case "Quota" "quota or rate limit" "RESOURCE_EXHAUSTED: quota exceeded" "/iam-admin/quotas?"
test_case "Secret" "Secret Manager resource" "Secret Manager: secrets/photointel-demo NOT_FOUND" "/security/secret-manager?"
test_case "State lock" "Terraform state is locked" "Error acquiring the state lock" "/terraform/language/state/locking"
: > "$GITHUB_STEP_SUMMARY"
ci_run "Success" bash -c 'echo complete' >"$tmp/success" 2>&1
assert_contains "$tmp/success" "completed in"
[[ ! -s "$GITHUB_STEP_SUMMARY" ]] || { echo 'Success generated a failure summary' >&2; exit 1; }
echo 'PASS: success and no failure summary'

# The gcloud path must use the existing Python classifier, not Bash regexes.
printf '%s\n' 'PERMISSION_DENIED Required permission cloudbuild.builds.create Bearer secret-value' >"$tmp/gcloud.log"
ci_help gcloud "$tmp/gcloud.log" >"$tmp/gcloud-diagnosis"
assert_contains "$tmp/gcloud-diagnosis" 'cloudbuild.builds.create'
assert_contains "$tmp/gcloud-diagnosis" 'GCP IAM'
if grep -Fq 'secret-value' "$tmp/gcloud-diagnosis"; then
  echo 'GCP diagnosis leaked provider output' >&2
  exit 1
fi
printf '%s\n' 'NOT_FOUND: service account does not exist' >"$tmp/gcloud.log"
ci_help gcloud "$tmp/gcloud.log" >"$tmp/gcloud-diagnosis"
assert_contains "$tmp/gcloud-diagnosis" 'Resource not found (404)'
assert_contains "$tmp/gcloud-diagnosis" 'Service accounts'
echo 'PASS: shared Python gcloud classification and redaction'
