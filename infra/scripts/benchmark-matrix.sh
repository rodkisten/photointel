#!/usr/bin/env bash
set -euo pipefail
# Rollback still creates WAL/dead tuples: select a disposable development database.
if [[ "${PHOTOINTEL_BENCHMARK_SYNTHETIC:-}" != 1 ]]; then
  printf 'Use um banco descartável e PHOTOINTEL_BENCHMARK_SYNTHETIC=1.\n' >&2
  exit 2
fi
metadata_sizes=(10000 100000 176000)
if [[ "${BENCHMARK_INCLUDE_500K:-0}" == 1 ]]; then
  metadata_sizes+=(500000)
fi
for assets in "${metadata_sizes[@]}"; do
  uv run python -m photointel.cli benchmark --assets "$assets" \
    --timeout-seconds "${BENCHMARK_TIMEOUT_SECONDS:-600}" \
    --output "reports/benchmark-$assets.json"
done
uv run python -m photointel.cli benchmark --assets 10000 --vectors 10000 \
  --timeout-seconds "${BENCHMARK_TIMEOUT_SECONDS:-600}" \
  --output reports/benchmark-vectors-10000.json
