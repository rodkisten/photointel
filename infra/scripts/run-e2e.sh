#!/usr/bin/env bash
# Real local services, with simulated inference explicitly restricted to test mode.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
if [[ "${APP_ENV:-}" != test || "${INFERENCE_BACKEND:-}" != test || "${GPU_ENABLED:-}" != true ]]; then
  printf 'E2E exige APP_ENV=test, INFERENCE_BACKEND=test e GPU_ENABLED=true explícitos.\n' >&2
  exit 2
fi
if [[ "${JOYTAG_MODEL_REVISION:-}" != 1111111111111111111111111111111111111111 || "${SIGLIP_MODEL_REVISION:-}" != 2222222222222222222222222222222222222222 ]]; then
  printf 'E2E exige revisões fictícias explícitas dos modelos de teste.\n' >&2
  exit 2
fi
export AUTH_MODE=local ICLOUD_ENABLED=false
export FRONTEND_ORIGIN=http://127.0.0.1:4173 API_ORIGIN=http://127.0.0.1:8000
export AUTH_REJECTION_API_URL=http://127.0.0.1:8001
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/photointel-uv-cache}"
export PLAYWRIGHT_JUNIT_OUTPUT_FILE="${PLAYWRIGHT_JUNIT_OUTPUT_FILE:-../../reports/browser.xml}"
mkdir -p reports
uv run --no-sync python -m photointel.cli seed --synthetic-assets 12
# A seed also executes jobs; require a fresh heartbeat from the long-lived worker.
rm -f /tmp/photointel-worker.heartbeat
process_ids=()
cleanup() {
  for process_id in "${process_ids[@]}"; do
    kill "$process_id" 2>/dev/null || true
  done
  for process_id in "${process_ids[@]}"; do
    wait "$process_id" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
uv run --no-sync uvicorn photointel.main:app --host 127.0.0.1 --port 8000 > reports/api.log 2>&1 &
process_ids+=("$!")
uv run --no-sync python -m photointel.services.worker > reports/worker.log 2>&1 &
worker_process_id=$!
process_ids+=("$worker_process_id")
AUTH_MODE=cloudflare ACCESS_TEAM_DOMAIN=ci.cloudflareaccess.com ACCESS_AUDIENCE=ci \
  ACCESS_ALLOWED_EMAILS='["ci@example.invalid"]' \
  uv run --no-sync uvicorn photointel.main:app --host 127.0.0.1 --port 8001 > reports/auth-rejection-api.log 2>&1 &
process_ids+=("$!")
export PHOTOINTEL_E2E_WORKER_PID="$worker_process_id"
uv run --no-sync python - <<'PY'
import os
import time
import urllib.request
from pathlib import Path

deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    try:
        for port in (8000, 8001):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health/ready", timeout=2
            ) as response:
                if response.status != 200:
                    raise OSError("API readiness failed")
        os.kill(int(os.environ["PHOTOINTEL_E2E_WORKER_PID"]), 0)
        age = time.time() - float(
            Path("/tmp/photointel-worker.heartbeat").read_text().strip()
        )
        if not 0 <= age <= 30:
            raise OSError("Worker heartbeat is stale")
        break
    except (OSError, ValueError):
        time.sleep(1)
else:
    raise SystemExit("API/strict API/worker readiness failed; inspect reports/*.log")
PY
npm --prefix apps/web run test:e2e -- --reporter=list,junit
