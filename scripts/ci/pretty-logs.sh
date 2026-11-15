#!/usr/bin/env bash
# Source from GitHub Actions steps: source scripts/ci/pretty-logs.sh
# Never pass secret-bearing arguments to ci_run; use environment variables and stdin.
_ci_color() { if [[ -t 1 || "${GITHUB_ACTIONS:-}" == true ]] && [[ "${NO_COLOR:-}" != 1 ]]; then printf '\033[%sm' "$1"; fi; }
ci_note() { printf '%sℹ %s%s\n' "$(_ci_color '36')" "$*" "$(_ci_color 0)"; }
ci_ok() { printf '%s✔ %s%s\n' "$(_ci_color '32')" "$*" "$(_ci_color 0)"; }
ci_warn() { printf '%s⚠ %s%s\n' "$(_ci_color '33')" "$*" "$(_ci_color 0)"; [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::warning::%s\n' "$*"; }
ci_fail() { printf '%s✖ %s%s\n' "$(_ci_color '31')" "$*" "$(_ci_color 0)" >&2; [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::error::%s\n' "$*" >&2; }
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
    local hint="Inspect the CLI output above and verify the command's configuration."
    case "$1" in
      gcloud) hint="Check active project, workload identity, required IAM roles, and whether the resource exists." ;;
      terraform) hint="Check state locking, provider permissions, drift, and the reviewed plan before retrying." ;;
      docker) hint="Check Docker daemon, registry authentication, image reference, and build context." ;;
      wrangler) hint="Check Cloudflare account, API token scopes, configuration, and deployment environment." ;;
      python3|python) hint="Read the Python traceback above and verify runtime dependencies and environment variables." ;;
    esac
    ci_fail "$label failed (exit ${status}, ${duration}s). $hint"
  fi
  [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::endgroup::\n'
  return "$status"
}
