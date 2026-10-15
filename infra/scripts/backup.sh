#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
compose=(bash infra/scripts/compose.sh)
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$repo_dir/backups/$stamp"
mkdir -p "$backup_dir"
chmod 0700 "$repo_dir/backups" "$backup_dir"
export_path="/data/processing/metadata-export-$stamp"
cleanup_export() {
  "${compose[@]}" exec -T api python -c 'import shutil, sys; from pathlib import Path; path = Path(sys.argv[1]); assert path.parent == Path("/data/processing") and path.name.startswith("metadata-export-"); shutil.rmtree(path, ignore_errors=True)' "$export_path" >/dev/null 2>&1 || true
}
trap cleanup_export EXIT
"${compose[@]}" exec -T postgres sh -ec 'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl' > "$backup_dir/postgres.dump"
"${compose[@]}" exec -T api python -m photointel.cli export --output "$export_path"
container_id="$("${compose[@]}" ps -q api)"
if [[ -z "$container_id" ]]; then printf 'API não está executando.\n' >&2; exit 1; fi
docker cp "$container_id:$export_path" "$backup_dir/metadata"
python3 infra/scripts/backup-manifest.py "$backup_dir"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null || { printf 'Instale age para a criptografia solicitada.\n' >&2; exit 1; }
  tar -C "$backup_dir" -cf - postgres.dump metadata manifest.json | age -r "$BACKUP_AGE_RECIPIENT" -o "$backup_dir/backup.tar.age"
  printf 'Arquivo criptografado criado. Cópias privadas locais retidas para recuperação.\n'
fi
printf 'Backup finalizado em %s; execute make restore-test para testar o mecanismo com dados sintéticos.\n' "$backup_dir"
