#!/usr/bin/env bash
# Exercise isolated GitHub migration venv without Neon/GCP credentials.
set -Eeuo pipefail
cd "$(dirname "$0")/../../.."
MIGRATION_TEST_VENV="$(mktemp -d "${RUNNER_TEMP:-/tmp}/photointel-migrate-test-XXXXXX")"
trap 'rm -rf "$MIGRATION_TEST_VENV"' EXIT
python3 -m venv "$MIGRATION_TEST_VENV"
"$MIGRATION_TEST_VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r infra/gcp/migration-requirements.txt
# No PYTHONPATH: the import must work exactly as deployed when calling by path.
env -u PYTHONPATH "$MIGRATION_TEST_VENV/bin/python" infra/gcp/check_migration_runtime.py
