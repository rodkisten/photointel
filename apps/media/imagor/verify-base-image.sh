#!/usr/bin/env bash
# Fail closed before publishing an Imagor image.
set -euo pipefail

base_image="${1:-}"
if [[ ! "$base_image" =~ ^shumc/imagor@sha256:[a-f0-9]{64}$ ]]; then
  echo "Invalid Imagor base image. Expected shumc/imagor@sha256:<64 lowercase hex digits>." >&2
  exit 2
fi

if [[ "${2:-}" == "--verify-remote" ]]; then
  command -v docker >/dev/null || { echo "docker is required for remote verification" >&2; exit 3; }
  docker manifest inspect "$base_image" >/dev/null
fi
printf 'Validated immutable Imagor base image reference.\n'
