#!/usr/bin/env bash
# Test only isolated, explicitly named scratch databases; never replace production.
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
compose=(bash infra/scripts/compose.sh)
nonce="$(date -u +%Y%m%d%H%M%S)_$$"
source_db="pi_restore_src_$nonce"
target_db="pi_restore_dst_$nonce"
scratch="$(mktemp -d "$repo_dir/.restore-test.XXXXXX")"
psql_command() {
  "${compose[@]}" exec -T postgres sh -ec 'exec psql --username="$POSTGRES_USER" --dbname=postgres --set=ON_ERROR_STOP=1' <<< "$1"
}
cleanup() {
  psql_command "DROP DATABASE IF EXISTS $source_db WITH (FORCE);" >/dev/null || true
  psql_command "DROP DATABASE IF EXISTS $target_db WITH (FORCE);" >/dev/null || true
  rm -f "$scratch/fixture.dump" "$scratch/source.json" "$scratch/target.json"
  rmdir "$scratch" 2>/dev/null || true
}
trap cleanup EXIT
psql_command "CREATE DATABASE $source_db; CREATE DATABASE $target_db;"
db_environment() {
  # Use the container's existing credential without printing it or sourcing .env.
  "${compose[@]}" exec -T postgres sh -ec 'printf "postgresql+asyncpg://%s:%s@postgres:5432/%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$1"' sh "$1"
}
source_url="$(db_environment "$source_db")"
target_url="$(db_environment "$target_db")"
scratch_env=(-e APP_ENV=test -e AUTH_MODE=local -e INFERENCE_BACKEND=test -e STORAGE_BACKEND=local -e STORAGE_LOCAL_DIRECTORY=/tmp/restore-media -e ICLOUD_ENABLED=false -e GPU_ENABLED=false)
"${compose[@]}" run --no-deps --rm -T "${scratch_env[@]}" -e "DATABASE_URL=$source_url" migrate alembic -c infra/migrations/alembic.ini upgrade head
"${compose[@]}" run --no-deps --rm -T "${scratch_env[@]}" -e "DATABASE_URL=$source_url" api python -m photointel.cli seed --synthetic-assets 16
"${compose[@]}" run --no-deps --rm -T "${scratch_env[@]}" -e "DATABASE_URL=$source_url" api python infra/scripts/fingerprint.py > "$scratch/source.json"
"${compose[@]}" exec -T postgres sh -ec 'exec pg_dump --username="$POSTGRES_USER" --dbname="$1" --format=custom --no-owner --no-acl' sh "$source_db" > "$scratch/fixture.dump"
"${compose[@]}" exec -T postgres sh -ec 'exec pg_restore --username="$POSTGRES_USER" --dbname="$1" --no-owner --no-acl --exit-on-error' sh "$target_db" < "$scratch/fixture.dump"
"${compose[@]}" run --no-deps --rm -T "${scratch_env[@]}" -e "DATABASE_URL=$target_url" api python infra/scripts/fingerprint.py > "$scratch/target.json"
cmp "$scratch/source.json" "$scratch/target.json"
python3 - "$scratch/source.json" <<'PY'
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
fixture = json.loads(Path(sys.argv[1]).read_text())
asset_tables = {k: v for k, v in fixture.items() if k in {"assets", "asset"}}
if not asset_tables or sum(v["rows"] for v in asset_tables.values()) < 16:
    raise SystemExit("Fixture não contém as 16 mídias sintéticas esperadas")
Path("reports").mkdir(exist_ok=True)
Path("reports/restore-test.json").write_text(json.dumps({
    "executed_at": datetime.now(UTC).isoformat(), "status": "passed",
    "scope": "synthetic scratch databases only", "tables": fixture,
}, indent=2) + "\n")
PY
printf 'Restore sintético verificado; relatório em reports/restore-test.json.\n'
