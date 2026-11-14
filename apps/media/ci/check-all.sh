#!/usr/bin/env bash
# Run every independent Media CI check and report all failures at the end.
set -uo pipefail
cd "$(dirname "$0")/../../.."
failures=()
run_check() {
  local label="$1"
  shift
  echo "::group::$label"
  "$@"
  local status=$?
  echo "::endgroup::"
  if (( status != 0 )); then
    failures+=("$label (exit $status)")
    echo "::error title=Media CI failed::$label exited with status $status"
  fi
  return 0
}
run_component() {
  local component="$1"
  local path="apps/media/$component"
  if ! (cd "$path" && npm install --no-audit --no-fund); then
    failures+=("$component: dependency installation")
    echo "::error title=Media CI failed::$component dependency installation failed"
    return
  fi
  if [[ "$component" == "gateway" ]]; then
    run_check "$component: typecheck" bash -c "cd '$path' && npm run typecheck"
    run_check "$component: tests" bash -c "cd '$path' && npm test"
  else
    run_check "$component: build" bash -c "cd '$path' && npm run build"
    run_check "$component: tests" bash -c "cd '$path' && npm test"
  fi
}
run_check "Imagor: base-image validation" bash apps/media/imagor/test-verify-base-image.sh
for component in image video gateway; do
  run_component "$component"
done
{
  echo "### Media CI results"
  if (( ${#failures[@]} == 0 )); then
    echo "All checks passed."
  else
    echo "${#failures[@]} check(s) failed:"
    printf -- '- %s\n' "${failures[@]}"
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
if (( ${#failures[@]} > 0 )); then
  printf 'Failed checks:\n'
  printf ' - %s\n' "${failures[@]}"
  exit 1
fi
echo "All Media CI checks passed."
