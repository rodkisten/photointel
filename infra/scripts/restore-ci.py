#!/usr/bin/env python3
"""Exercise actual migrations, pg_dump and pg_restore on isolated CI databases."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-container", required=True)
    arguments = parser.parse_args()
    if os.environ.get("APP_ENV") != "test":
        raise SystemExit("Restore CI requires APP_ENV=test")
    container = arguments.postgres_container
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", container):
        raise SystemExit("Invalid PostgreSQL container identifier")
    import psycopg
    from psycopg import sql

    url = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
    parsed = urlsplit(url)
    nonce = uuid4().hex[:16]
    source, target = (f"pi_restore_{kind}_{nonce}" for kind in ("src", "dst"))
    created: list[str] = []
    with psycopg.connect(url, autocommit=True) as administration:
        try:
            for database in (source, target):
                administration.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
                )
                created.append(database)
            with tempfile.TemporaryDirectory(prefix="photointel-restore-") as temporary:
                directory = Path(temporary)

                def environment(database: str) -> dict[str, str]:
                    database_url = urlunsplit(parsed._replace(path="/" + database))
                    database_url = database_url.replace(
                        "postgresql://", "postgresql+asyncpg://", 1
                    )
                    return dict(
                        os.environ,
                        APP_ENV="test",
                        AUTH_MODE="local",
                        DATABASE_URL=database_url,
                        MIGRATION_DATABASE_URL=database_url,
                        STORAGE_BACKEND="local",
                        STORAGE_LOCAL_DIRECTORY=str(directory / "media"),
                        TEMP_DIRECTORY=str(directory / "processing"),
                        INFERENCE_BACKEND="test",
                        GPU_ENABLED="false",
                        ICLOUD_ENABLED="false",
                    )

                def run_python(*args: str, database: str = source) -> None:
                    subprocess.run(
                        [sys.executable, *args],
                        cwd=ROOT,
                        env=environment(database),
                        stdout=sys.stderr,
                        check=True,
                    )

                run_python(
                    "-m",
                    "alembic",
                    "-c",
                    "infra/migrations/alembic.ini",
                    "upgrade",
                    "head",
                )
                run_python("-m", "photointel.cli", "seed", "--synthetic-assets", "16")
                dump = directory / "fixture.dump"
                commands = (
                    ("pg_dump", source, "wb", "--format=custom --no-owner --no-acl"),
                    ("pg_restore", target, "rb", "--no-owner --no-acl --exit-on-error"),
                )
                for executable, database, mode, options in commands:
                    command = (
                        f'exec {executable} --username="$POSTGRES_USER" '
                        f'--dbname="$1" {options}'
                    )
                    with dump.open(mode) as stream:
                        subprocess.run(
                            [
                                "docker",
                                "exec",
                                "-i",
                                container,
                                "sh",
                                "-ec",
                                command,
                                "sh",
                                database,
                            ],
                            **({"stdout": stream} if mode == "wb" else {"stdin": stream}),
                            check=True,
                        )
                fingerprints = []
                for database in (source, target):
                    result = subprocess.check_output(
                        [sys.executable, "infra/scripts/fingerprint.py"],
                        cwd=ROOT,
                        env=environment(database),
                        text=True,
                    )
                    fingerprints.append(json.loads(result))
                if fingerprints[0] != fingerprints[1]:
                    raise SystemExit("Restored fixture differs from its source")
                if fingerprints[0].get("assets", {}).get("rows") != 16:
                    raise SystemExit("Restore fixture must contain 16 synthetic assets")
                report = ROOT / "reports/restore-test.json"
                report.parent.mkdir(exist_ok=True)
                report.write_text(
                    json.dumps(
                        {
                            "executed_at": datetime.now(UTC).isoformat(),
                            "status": "passed",
                            "scope": "isolated synthetic databases only",
                            "tables": fingerprints[0],
                        },
                        indent=2,
                    )
                    + "\n"
                )
        finally:
            for database in reversed(created):
                administration.execute(
                    sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                        sql.Identifier(database)
                    )
                )
    print("Synthetic database dump/restore and every table fingerprint verified")


if __name__ == "__main__":
    main()
