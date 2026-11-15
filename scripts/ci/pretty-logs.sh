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
  local command="$1" hint url title
  case "$command" in
    gcloud)
      hint="Verify the GCP project, workload identity, IAM role, and resource status."
      title="GCP IAM"; url="https://console.cloud.google.com/iam-admin/iam?project=photointel" ;;
    terraform)
      hint="Inspect the plan and state lock before retrying. Never force-unlock an active run."
      title="Terraform state locking"; url="https://developer.hashicorp.com/terraform/language/state/locking" ;;
    docker)
      hint="Verify Artifact Registry authentication, repository permissions, and image digest."
      title="Artifact Registry"; url="https://console.cloud.google.com/artifacts?project=photointel" ;;
    wrangler)
      hint="Verify Cloudflare account, token scopes, and deployment configuration."
      title="Cloudflare dashboard"; url="https://dash.cloudflare.com/" ;;
    python3|python|bash)
      hint="Inspect the traceback or command output and verify configuration and credentials."
      title="Workflow run"; url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-rodkisten/photointel}/actions/runs/${GITHUB_RUN_ID:-0}" ;;
    *)
      hint="Inspect the original command output and the environment configuration."
      title="Workflow run"; url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-rodkisten/photointel}/actions/runs/${GITHUB_RUN_ID:-0}" ;;
  esac
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
  "$@" && status=0 || status=$?
  duration=$((SECONDS-start))
  if (( status == 0 )); then
    ci_ok "$label completed in ${duration}s"
  else
    local hint title url
    { IFS= read -r hint; IFS= read -r title; IFS= read -r url; } < <(ci_help "$1")
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
  return "$status"
}
