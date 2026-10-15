#!/usr/bin/env bash
set -euo pipefail
# Each CLI run rolls back its generated metadata; still select a scratch DB.
if [[ "${PHOTOINTEL_BENCHMARK_SYNTHETIC:-}" != 1 ]]; then
  printf 'Use um banco descartável e PHOTOINTEL_BENCHMARK_SYNTHETIC=1.\n' >&2
  exit 2
fi
for assets in 10000 100000 176000 500000; do
  make benchmark "ASSETS=$assets" "REPORT=reports/benchmark-$assets.json"
done
