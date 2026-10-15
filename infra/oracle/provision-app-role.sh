#!/usr/bin/env bash
# Explicit administrator operation; passwords are read inside the database container.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
PHOTOINTEL_COMPOSE_MODE=prod bash infra/scripts/compose.sh exec -T postgres sh -ec '
  test "$POSTGRES_APP_USER" != "$POSTGRES_USER"
  exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
    --set=app_role="$POSTGRES_APP_USER" --set=app_password="$POSTGRES_APP_PASSWORD" \
    --set=database_name="$POSTGRES_DB" --set=ON_ERROR_STOP=1
' < infra/oracle/provision-app-role.sql
