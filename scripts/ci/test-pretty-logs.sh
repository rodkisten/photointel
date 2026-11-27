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
  # Cloud diagnostics must be tested with a cloud command, not generic bash.
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/gcloud" <<'SH'
#!/usr/bin/env bash
printf '%s\\n' "$CI_TEST_SNIPPET"
exit 17
SH
  chmod +x "$tmp/bin/gcloud"
  CI_TEST_SNIPPET="$snippet" PATH="$tmp/bin:$PATH" ci_run "$name" gcloud version >"$tmp/output" 2>&1 || code=$?
  [[ "$code" -eq 17 ]] || { echo "Wrong exit code for $name: $code" >&2; exit 1; }
  assert_contains "$tmp/output" "$snippet"
  assert_contains "$GITHUB_STEP_SUMMARY" "$expected"
  assert_contains "$GITHUB_STEP_SUMMARY" "$link"
  assert_contains "$tmp/output" '::group::📄 Raw output ·'
  assert_contains "$tmp/output" '::endgroup::'
  echo "PASS: $name"
}
test_case "IAM failure" "Access denied (403)" "PERMISSION_DENIED: 403" "/iam-admin/iam?"
test_case "Missing resource" "Resource not found (404)" "NOT_FOUND: 404" "/home/dashboard?"
test_case "Quota" "quota or rate limit" "RESOURCE_EXHAUSTED: quota exceeded" "/iam-admin/quotas?"
test_case "Secret" "Secret Manager resource" "Secret Manager: secrets/photointel-demo NOT_FOUND" "/security/secret-manager?"
# Terraform locking belongs to the Terraform command family, not gcloud.
# Verify its classifier directly, preserving the original regression coverage.
printf '%s\n' 'Error acquiring the state lock' >"$tmp/terraform-lock.log"
ci_help terraform "$tmp/terraform-lock.log" >"$tmp/terraform-lock-diagnosis"
assert_contains "$tmp/terraform-lock-diagnosis" 'O state do Terraform está travado'
assert_contains "$tmp/terraform-lock-diagnosis" '/terraform/language/state/locking'
echo 'PASS: Terraform state lock diagnosis'
: > "$GITHUB_STEP_SUMMARY"
ci_run "Success" bash -c 'echo complete' >"$tmp/success" 2>&1
assert_contains "$tmp/success" "completed in"
assert_contains "$tmp/success" '::group::📄 Raw output · Success'
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

# End-to-end: ci_run invokes a fake gcloud executable, preserves exit status,
# routes the captured stderr to the standalone Python module, and redacts hints.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/gcloud" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'PERMISSION_DENIED: Required permission cloudbuild.builds.create Bearer private-ci-token' >&2
exit 23
SH
chmod +x "$tmp/bin/gcloud"
: > "$GITHUB_STEP_SUMMARY"
code=0
PATH="$tmp/bin:$PATH" ci_run "GCloud integration failure" gcloud builds submit >"$tmp/integration-output" 2>&1 || code=$?
[[ "$code" -eq 23 ]] || { echo "Wrong gcloud integration exit: $code" >&2; exit 1; }
assert_contains "$GITHUB_STEP_SUMMARY" 'cloudbuild.builds.create'
assert_contains "$GITHUB_STEP_SUMMARY" '/iam-admin/iam?'
assert_contains "$GITHUB_STEP_SUMMARY" '**Exit code:** 23'
assert_contains "$tmp/integration-output" '::endgroup::'
if grep -Fq 'private-ci-token' "$GITHUB_STEP_SUMMARY"; then
  echo 'Secret leaked into workflow summary' >&2
  exit 1
fi
echo 'PASS: gcloud end-to-end failure diagnosis, exit code and safe summary'

# Standalone Python diagnostics: authentication, quota and Secret Manager.
for scenario in auth quota secret; do
  case "$scenario" in
    auth) snippet='UNAUTHENTICATED: no active account Bearer private-ci-token'; expected='GCP authentication required'; route='/iam-admin/iam?' ;;
    quota) snippet='RESOURCE_EXHAUSTED: quota exceeded Bearer private-ci-token'; expected='GCP quota or rate limit exceeded'; route='/iam-admin/quotas?' ;;
    secret) snippet='PERMISSION_DENIED: secretmanager.versions.access Secret Manager Bearer private-ci-token'; expected='Secret Manager'; route='/security/secret-manager?' ;;
  esac
  printf '%s\n' "$snippet" >"$tmp/gcloud.log"
  python3 -m scripts.ci.gcloud_diagnostics "$tmp/gcloud.log" photointel >"$tmp/gcloud-diagnosis"
  assert_contains "$tmp/gcloud-diagnosis" "$expected"
  assert_contains "$tmp/gcloud-diagnosis" "$route"
  if grep -Fq 'private-ci-token' "$tmp/gcloud-diagnosis"; then
    echo "Secret leaked from $scenario diagnosis" >&2
    exit 1
  fi
  echo "PASS: standalone Python $scenario diagnosis"
done

# Full ci_run integration for all new GCP classifications.
cat >"$tmp/bin/gcloud" <<'SH'
#!/usr/bin/env bash
case "$1" in
  auth) echo 'UNAUTHENTICATED: no active account Bearer private-ci-token' >&2 ;;
  quota) echo 'RESOURCE_EXHAUSTED: quota exceeded Bearer private-ci-token' >&2 ;;
  secret) echo 'PERMISSION_DENIED: secretmanager.versions.access Secret Manager Bearer private-ci-token' >&2 ;;
  *) exit 2 ;;
esac
exit 29
SH
chmod +x "$tmp/bin/gcloud"
for scenario in auth quota secret; do
  case "$scenario" in
    auth) expected='GCP authentication required'; route='/iam-admin/iam?' ;;
    quota) expected='GCP quota or rate limit exceeded'; route='/iam-admin/quotas?' ;;
    secret) expected='Secret Manager'; route='/security/secret-manager?' ;;
  esac
  : > "$GITHUB_STEP_SUMMARY"
  code=0
  PATH="$tmp/bin:$PATH" ci_run "GCloud $scenario failure" gcloud "$scenario" >"$tmp/integration-output" 2>&1 || code=$?
  [[ "$code" -eq 29 ]] || { echo "Wrong exit code for $scenario: $code" >&2; exit 1; }
  assert_contains "$GITHUB_STEP_SUMMARY" "$expected"
  assert_contains "$GITHUB_STEP_SUMMARY" "$route"
  assert_contains "$GITHUB_STEP_SUMMARY" '**Exit code:** 29'
  assert_contains "$tmp/integration-output" '::endgroup::'
  if grep -Fq 'private-ci-token' "$GITHUB_STEP_SUMMARY"; then
    echo "Secret leaked in $scenario summary" >&2
    exit 1
  fi
  echo "PASS: ci_run $scenario integration, summary and redaction"
done

# Docker and Terraform share catalog diagnostics while retaining collapsed raw output.
for tool in docker terraform; do
  cat >"$tmp/bin/$tool" <<'SH'
#!/usr/bin/env bash
printf '%s\n' 'ERROR: operation failed (test fixture)' >&2
exit 31
SH
  chmod +x "$tmp/bin/$tool"
  : > "$GITHUB_STEP_SUMMARY"
  code=0
  PATH="$tmp/bin:$PATH" ci_run "$tool integration" "$tool" version >"$tmp/integration-output" 2>&1 || code=$?
  [[ "$code" -eq 31 ]] || { echo "Wrong $tool exit: $code" >&2; exit 1; }
  case "$tool" in
    docker) assert_contains "$GITHUB_STEP_SUMMARY" 'Artifact Registry' ;;
    terraform) assert_contains "$GITHUB_STEP_SUMMARY" 'Terraform GCP' ;;
  esac
  assert_contains "$tmp/integration-output" '::group::📄 Raw output'
  assert_contains "$tmp/integration-output" '::endgroup::'
  echo "PASS: $tool structured diagnosis and raw group"
done
