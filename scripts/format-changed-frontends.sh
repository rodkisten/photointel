#!/usr/bin/env bash
# Format only tracked, eligible files in the selected frontend(s).
set -Eeuo pipefail

cd "$(git rev-parse --show-toplevel)"

target="${TARGET:-both}"
mode="${MODE:-changed}"
base_ref="${BASE_REF:-}"
manifest="${RUNNER_TEMP:-/tmp}/photointel-format-paths.nul"
: > "$manifest"

case "$target" in
  web) scopes=(web) ;;
  manage) scopes=(manage) ;;
  both) scopes=(web manage) ;;
  *) echo "::error::Invalid target: $target"; exit 1 ;;
esac

case "$mode" in
  changed)
    if [[ -z "$base_ref" ]]; then
      if ! base_ref="$(git rev-parse --verify HEAD^ 2>/dev/null)"; then
        echo "::error::No parent commit found. Specify base_ref to compare."
        exit 1
      fi
    fi
    if ! base_sha="$(git rev-parse --verify "${base_ref}^{commit}" 2>/dev/null)"; then
      echo "::error::Invalid base_ref: $base_ref"
      exit 1
    fi
    echo "Comparing $base_sha..HEAD"
    ;;
  all) echo "Selecting all tracked frontend files" ;;
  *) echo "::error::Invalid mode: $mode"; exit 1 ;;
esac

validation_ok=true
selected=0

for scope in "${scopes[@]}"; do
  paths=()
  if [[ "$mode" == changed ]]; then
    mapfile -d '' -t paths < <(git diff --name-only -z --diff-filter=ACMR "$base_sha" HEAD -- "apps/$scope/")
  else
    mapfile -d '' -t paths < <(git ls-files -z -- "apps/$scope/")
  fi

  lint=()
  format=()
  for path in "${paths[@]}"; do
    [[ -f "$path" ]] || continue
    case "$path" in
      *.js|*.mjs|*.cjs|*.jsx|*.ts|*.tsx)
        lint+=("${path#apps/$scope/}")
        format+=("$path")
        ;;
      *.css|*.html|*.json|*.jsonc)
        format+=("$path")
        ;;
    esac
  done

  if (( ${#format[@]} == 0 )); then
    echo "No eligible $scope files to format."
    continue
  fi

  (( selected += ${#format[@]} ))
  printf '%s\0' "${format[@]}" >> "$manifest"
  {
    echo "### $scope (${#format[@]} selected)"
    printf -- '- %s\n' "${format[@]}"
  } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

  if (( ${#lint[@]} > 0 )); then
    if ! ( cd "apps/$scope" && ./node_modules/.bin/eslint --fix -- "${lint[@]}" ); then
      validation_ok=false
      echo "::warning title=ESLint ($scope)::Some rules cannot be fixed automatically; see ESLint output."
    fi
  fi

  if ! ./node_modules/.bin/prettier --write --ignore-path .prettierignore -- "${format[@]}"; then
    validation_ok=false
    echo "::error title=Prettier ($scope)::Formatting failed."
  fi

  if ! ./node_modules/.bin/prettier --check --ignore-path .prettierignore -- "${format[@]}"; then
    validation_ok=false
    echo "::error title=Prettier ($scope)::Files did not pass the formatting check."
  fi
done

if ! git diff --check; then
  validation_ok=false
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  if (( selected > 0 )); then
    echo 'has_files=true' >> "$GITHUB_OUTPUT"
  else
    echo 'has_files=false' >> "$GITHUB_OUTPUT"
  fi
  echo "validation_ok=$validation_ok" >> "$GITHUB_OUTPUT"
fi

echo "Selected $selected file(s); validation_ok=$validation_ok"
# Always return success here so auto-fix changes can be committed first.
# The workflow fails in a subsequent step if non-fixable issues remain.
