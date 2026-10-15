#!/usr/bin/env python3
"""Fingerprint a small synthetic restore fixture; not a large-library benchmark."""

import hashlib
import json
import os

import psycopg
from psycopg import sql

url = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
result = {}
with psycopg.connect(url) as connection:
    tables = connection.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    ).fetchall()
    for (table,) in tables:
        query = sql.SQL("SELECT row_to_json(t)::text FROM {} t").format(
            sql.Identifier("public", table)
        )
        rows = sorted(row[0] for row in connection.execute(query))
        digest = hashlib.sha256("\n".join(rows).encode()).hexdigest()
        result[table] = {"rows": len(rows), "sha256": digest}
print(json.dumps(result, sort_keys=True))
