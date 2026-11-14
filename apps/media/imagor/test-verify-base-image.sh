#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
script="apps/media/imagor/verify-base-image.sh"
valid="shumc/imagor@sha256:$(printf 'a%.0s' {1..64})"
bash "$script" "$valid" >/dev/null
for invalid in "" "shumc/imagor:latest" "alpine@sha256:$(printf 'a%.0s' {1..64})" "shumc/imagor@sha256:abc" "shumc/imagor@sha256:$(printf 'A%.0s' {1..64})"; do
  if bash "$script" "$invalid" >/dev/null 2>&1; then
    echo "Unexpectedly accepted invalid base image: $invalid" >&2
    exit 1
  fi
done
echo "Imagor digest validation: 6 cases passed"
