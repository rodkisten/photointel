#!/usr/bin/env bash
# Compatibility entrypoint for the operator's interactive SSH workflow.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$repo_dir/commit-session.sh"
