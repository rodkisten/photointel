#!/usr/bin/env bash
# Source from GitHub Actions steps: source scripts/ci/pretty-logs.sh
# Never pass secret-bearing arguments to ci_run; use environment variables and stdin.
_ci_color() { if [[ -t 1 || "${GITHUB_ACTIONS:-}" == true ]] && [[ "${NO_COLOR:-}" != 1 ]]; then printf '\033[%sm' "$1"; fi; }
ci_note() { printf '%sℹ %s%s\n' "$(_ci_color '36')" "$*" "$(_ci_color 0)"; }
ci_ok() { printf '%s✔ %s%s\n' "$(_ci_color '32')" "$*" "$(_ci_color 0)"; }
ci_warn() { printf '%s⚠ %s%s\n' "$(_ci_color '33')" "$*" "$(_ci_color 0)"; [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::warning::%s\n' "$*"; }
ci_fail() { printf '%s✖ %s%s\n' "$(_ci_color '31')" "$*" "$(_ci_color 0)" >&2; [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::error::%s\n' "$*" >&2; }
# Links are shown only on failures. URLs are public consoles, never credential-bearing.
ci_help() {
  local command="$1" logfile="${2:-}" hint title url
  local project="${CI_GCP_PROJECT:-photointel}"
  # Project IDs are validated before interpolating them into console links.
  [[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || project=photointel
  if [[ -f "$logfile" ]] && grep -Eqi 'Error acquiring the state lock|state lock|Lock Info:' "$logfile"; then
    hint="Terraform state is locked. Identify the owning run; never force-unlock an active operation."
    title="Terraform state locking"; url="https://developer.hashicorp.com/terraform/language/state/locking"
  elif [[ -f "$logfile" ]] && grep -Eqi 'RESOURCE_EXHAUSTED|quota exceeded|quota.*exceeded|429 Too Many Requests' "$logfile"; then
    hint="A quota or rate limit was reached. Inspect the affected service quota and retry only after capacity is available."
    title="GCP quotas"; url="https://console.cloud.google.com/iam-admin/quotas?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi 'secretmanager|Secret Manager|secrets/[^ ]+' "$logfile" && grep -Eqi '404|NOT_FOUND|not found|permission.denied|403|denied' "$logfile"; then
    hint="Secret Manager resource missing or access denied. Verify the secret, enabled version and service account IAM."
    title="Secret Manager"; url="https://console.cloud.google.com/security/secret-manager?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi '403|PERMISSION_DENIED|permission denied|does not have permission|not authorized' "$logfile"; then
    hint="Access denied (403). Verify the workflow identity and the exact IAM permission in the CLI output."
    title="GCP IAM"; url="https://console.cloud.google.com/iam-admin/iam?project=$project"
  elif [[ -f "$logfile" ]] && grep -Eqi '404|NOT_FOUND|not found' "$logfile"; then
    hint="Resource not found (404). Check the resource name, project, region and whether provisioning completed."
    title="GCP resources"; url="https://console.cloud.google.com/home/dashboard?project=$project"
  else
    case "$command" in
      gcloud) hint="Verify project, workload identity, IAM roles and resource status."; title="GCP IAM"; url="https://console.cloud.google.com/iam-admin/iam?project=$project" ;;
      terraform) hint="Inspect the plan, remote state, provider permissions and drift."; title="Terraform documentation"; url="https://developer.hashicorp.com/terraform/cli" ;;
      docker) hint="Verify registry authentication, repository permissions and immutable digest."; title="Artifact Registry"; url="https://console.cloud.google.com/artifacts?project=$project" ;;
      wrangler) hint="Verify Cloudflare account, token scopes and environment."; title="Cloudflare"; url="https://dash.cloudflare.com/" ;;
      *) hint="Inspect the CLI output and environment configuration."; title="Workflow run"; url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-rodkisten/photointel}/actions/runs/${GITHUB_RUN_ID:-0}" ;;
    esac
  fi
  printf '%s\n%s\n%s\n' "$hint" "$title" "$url"
}
ci_run() {
  if (( $# < 2 )); then ci_fail 'ci_run requires a safe label and a command'; return 2; fi
  local label="$1" status start duration; shift
  # Label must be a human-readable non-sensitive description, not shell arguments.
  [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::group::%s\n' "$label"
  ci_note "$label"
  start=$SECONDS
  # Preserve CLI output, exit status, ANSI colors, and stderr without logging credentials.
  local logfile
  logfile="$(mktemp)"
  chmod 600 "$logfile"
  # tee preserves the original CLI output while allowing diagnostics to inspect it.
  "$@" > >(tee "$logfile") 2> >(tee -a "$logfile" >&2) && status=0 || status=$?
  # Process substitutions may still be flushing; wait for their writers to finish.
  # A short-lived private file is removed before returning.

  duration=$((SECONDS-start))
  if (( status == 0 )); then
    ci_ok "$label completed in ${duration}s"
  else
    local hint title url
    local -a diagnosis
    mapfile -t diagnosis < <(ci_help "$1" "$logfile")
    hint="${diagnosis[0]}"
    title="${diagnosis[1]}"
    url="${diagnosis[2]}"
    ci_fail "$label failed (exit ${status}, ${duration}s). $hint"
    ci_note "Next action: $title ($url)"
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      {
        printf '\n### ❌ %s\n\n' "$label"
        printf -- '- **Exit code:** %s · **Duration:** %ss\n' "$status" "$duration"
        printf -- '- **Diagnosis:** %s\n' "$hint"
        printf -- '- **External action:** [%s](%s)\n' "$title" "$url"
        printf -- '- **Logs:** [Open this run](%s/%s/actions/runs/%s)\n' "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_REPOSITORY:-rodkisten/photointel}" "${GITHUB_RUN_ID:-0}"
      } >> "$GITHUB_STEP_SUMMARY"
    fi
  fi
  [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::endgroup::\n'
  rm -f "$logfile"
  return "$status"
}
