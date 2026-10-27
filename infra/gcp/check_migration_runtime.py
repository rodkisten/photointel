#!/usr/bin/env python3
"""Offline preflight for the *exact* Python env used by GitHub Neon migrations.

Runs no SQL, reads no cloud credentials, and must pass before accessing Neon.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_SRC = ROOT / "apps/api/src"
if not (APP_SRC / "photointel/__init__.py").is_file():
    raise SystemExit("MIGRATE_IMPORT: PhotoIntel package is absent from checkout")

# Exact src-layout package must be importable when this file is launched by its
# path from infra/gcp in an otherwise empty venv.
sys.path.insert(0, str(APP_SRC))

try:
    import alembic
    import psycopg
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import __version__ as sqlalchemy_version
    from photointel.db_connection import database_connection_options
    from migrate_workflow import connection_profile
except (ImportError, ModuleNotFoundError) as exc:
    # ImportError itself may reference env paths; module name only is enough.
    name = getattr(exc, "name", None) or "unknown"
    raise SystemExit(f"MIGRATE_IMPORT: Python dependency unavailable: {name}") from None

try:
    test = (
        "postgresql://test:test@ep-example.us-east-1.aws.neon.tech/photointel"
        "?sslmode=require&channel_binding=require"
    )
    conninfo, params = connection_profile(test)
    assert conninfo.startswith("postgresql://")
    assert "sslmode=verify-full" in conninfo or "sslmode=verify-full" in conninfo.replace("%2D", "-")
    assert "channel_binding=require" in conninfo
    assert params.get("connect_timeout") == 15
    config = Config(str(ROOT / "infra/migrations/alembic.ini"))
    scripts = ScriptDirectory.from_config(config)
    heads = scripts.get_heads()
    if len(heads) != 1:
        raise ValueError("Expected exactly one Alembic revision head")
except (ValueError, AssertionError, OSError, RuntimeError) as exc:
    raise SystemExit(
        "MIGRATE_PREFLIGHT: database configuration or Alembic revisions invalid"
    ) from None

print(f"✅ Migration runtime ready: Python {sys.version_info.major}.{sys.version_info.minor}; "
      f"SQLAlchemy {sqlalchemy_version}; Alembic revision {heads[0]}. "
      "Neon was not contacted.")
