#!/usr/bin/env bash
set -euo pipefail
repo_dir="${1:-/opt/photointel}"
if [[ "$EUID" -ne 0 ]]; then
  printf 'Execute como root para preparar permissões do host.\n' >&2
  exit 1
fi
if [[ "$repo_dir" != /* || "$repo_dir" == / ]]; then
  printf 'Informe um diretório absoluto específico.\n' >&2
  exit 1
fi
install -d -m 0750 "$repo_dir/var"
for directory in processing icloud-session icloud-downloads; do
  install -d -o 10001 -g 10001 -m 0700 "$repo_dir/var/$directory"
done
# pgvector:pg16 herda o usuário postgres da imagem Debian (UID/GID 999).
# Confira `docker run --rm --entrypoint id pgvector/pgvector:pg16 postgres`
# na imagem/digest escolhido antes de executar em outro sistema.
install -d -o 999 -g 999 -m 0700 "$repo_dir/var/postgres"
install -d -m 0700 "$repo_dir/backups"
printf 'Diretórios preparados. Docker e firewall devem ser configurados pelo administrador.\n'
