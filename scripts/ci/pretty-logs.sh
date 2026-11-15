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
    ci_fail "$label failed (exit ${status}, ${duration}s). Inspect CLI output above; verify IAM, project, and configuration before retrying."
  fi
  [[ "${GITHUB_ACTIONS:-}" == true ]] && printf '::endgroup::\n'
  return "$status"
}
