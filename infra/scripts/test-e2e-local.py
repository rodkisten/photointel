#!/usr/bin/env python3
"""Run real local browser acceptance against disposable PostgreSQL and MinIO."""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import boto3
import psycopg
from botocore.config import Config
from dotenv import dotenv_values
from psycopg import sql
from sqlalchemy.engine import URL

ROOT = Path(__file__).resolve().parents[2]


def local_endpoint(value: str) -> str:
    endpoint = urlsplit(value)
    if (
        endpoint.scheme not in {"http", "https"}
        or endpoint.hostname not in {"localhost", "127.0.0.1", "::1"}
        or endpoint.username
        or endpoint.password
        or endpoint.path not in {"", "/"}
        or endpoint.query
        or endpoint.fragment
    ):
        raise ValueError("E2E requires a local MinIO endpoint without URL credentials")
    return value.rstrip("/")


def port(value: str | int) -> int:
    number = int(value)
    if not 1024 <= number <= 65535:
        raise ValueError("E2E ports must be between 1024 and 65535")
    return number


def check_free_ports(ports: tuple[int, ...]) -> None:
    if len(ports) != 3 or len(set(ports)) != 3:
        raise ValueError("E2E API, strict API and frontend ports must differ")
    for number in ports:
        with socket.socket() as listener:
            try:
                listener.bind(("127.0.0.1", number))
            except OSError as error:
                raise ValueError(f"E2E port {number} is already occupied") from error


def test_environment(
    configuration: dict[str, str],
    database: str,
    bucket: str,
    temporary: Path,
    *,
    webkit: bool = False,
) -> dict[str, str]:
    if configuration.get("APP_ENV", "development") not in {"development", "test"}:
        raise ValueError("E2E refuses a production configuration")
    endpoint = local_endpoint(
        configuration.get("E2E_STORAGE_ENDPOINT", "http://127.0.0.1:9000")
    )
    password = configuration.get("POSTGRES_PASSWORD")
    storage_secret = configuration.get("MINIO_ROOT_PASSWORD")
    if not password or not storage_secret:
        raise ValueError("Run make setup: local PostgreSQL/MinIO secrets are missing")
    admin = URL.create(
        "postgresql",
        username=configuration.get("POSTGRES_USER", "photointel"),
        password=password,
        host="127.0.0.1",
        port=port(configuration.get("E2E_POSTGRES_PORT", "5432")),
        database=configuration.get("POSTGRES_DB", "photointel"),
    )
    environment = {**os.environ, **configuration}
    environment.update(
        {
            "APP_ENV": "test",
            "AUTH_MODE": "local",
            "EXECUTION_PLATFORM": "vps",
            "ICLOUD_ENABLED": "false",
            "ICLOUD_ACCOUNT": "",
            "ICLOUD_LIBRARY": "",
            "ICLOUD_SESSION_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
            "BRIDGE_ENROLLMENT_SECRET": secrets.token_urlsafe(48),
            "BRIDGE_TOKEN_PEPPER": secrets.token_urlsafe(48),
            "CORS_ORIGINS": "[]",
            "MODAL_ENDPOINT": "",
            "MODAL_TOKEN": "",
            "MODAL_PROXY_KEY": "",
            "MODAL_PROXY_SECRET": "",
            "APPLE_NATIVE_WRITE_ENABLED": "false",
            "AUTO_DELETE_ENABLED": "false",
            "VERIFICATION_GATES_ENFORCED": "false",
            "GPU_ENABLED": "true",
            "INFERENCE_BACKEND": "test",
            "JOYTAG_MODEL_REVISION": "1" * 40,
            "SIGLIP_MODEL_REVISION": "2" * 40,
            "DATABASE_URL": admin.set(
                drivername="postgresql+asyncpg", database=database
            ).render_as_string(hide_password=False),
            "MIGRATION_DATABASE_URL": "",
            "DATABASE_REQUIRE_TLS": "false",
            "DATABASE_POOL_MODE": "direct",
            "STORAGE_BACKEND": "s3",
            "STORAGE_ENDPOINT": endpoint,
            "STORAGE_BUCKET": bucket,
            "STORAGE_ACCESS_KEY": configuration.get(
                "MINIO_ROOT_USER", "photointel-local"
            ),
            "STORAGE_SECRET_KEY": storage_secret,
            "STORAGE_REGION": "us-east-1",
            "TEMP_DIRECTORY": str(temporary / "processing"),
            "ICLOUD_DOWNLOAD_DIRECTORY": str(temporary / "downloads"),
            "ICLOUD_SESSION_DIRECTORY": str(temporary / "session"),
            "E2E_API_PORT": str(port(configuration.get("E2E_API_PORT", "18000"))),
            "E2E_STRICT_API_PORT": str(
                port(configuration.get("E2E_STRICT_API_PORT", "18001"))
            ),
            "PLAYWRIGHT_WEB_PORT": str(
                port(configuration.get("PLAYWRIGHT_WEB_PORT", "14173"))
            ),
        }
    )
    if webkit:
        environment["PHOTOINTEL_TEST_WEBKIT"] = "1"
    return environment


def remove_bucket(client: Any, bucket: str) -> None:
    # This function is called only for the unique bucket created by this execution.
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if keys:
            client.delete_objects(Bucket=bucket, Delete={"Objects": keys})
    client.delete_bucket(Bucket=bucket)


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--webkit", action="store_true", help="Include WebKit acceptance")
    args = parser.parse_args()
    configuration = {
        key: value
        for key, value in dotenv_values(ROOT / ".env").items()
        if value is not None
    }
    # Explicit command variables take priority over the local development file.
    configuration.update(os.environ)
    nonce = uuid4().hex
    database, bucket = f"photointel_e2e_{nonce}", f"photointel-e2e-{nonce}"
    report: dict[str, Any] = {
        "started_at": datetime.now(UTC).isoformat(),
        "synthetic_only": True,
        "inference_backend": "test",
        "real_external_inference_validated": False,
    }
    result = 1
    database_created = bucket_created = False
    try:
        with tempfile.TemporaryDirectory(prefix="photointel-e2e-") as temporary:
            environment = test_environment(
                configuration,
                database,
                bucket,
                Path(temporary),
                webkit=args.webkit,
            )
            check_free_ports(
                tuple(
                    int(environment[name])
                    for name in (
                        "E2E_API_PORT",
                        "E2E_STRICT_API_PORT",
                        "PLAYWRIGHT_WEB_PORT",
                    )
                )
            )
            target = URL.create(
                "postgresql",
                username=configuration.get("POSTGRES_USER", "photointel"),
                password=configuration["POSTGRES_PASSWORD"],
                host="127.0.0.1",
                port=port(configuration.get("E2E_POSTGRES_PORT", "5432")),
                database=configuration.get("POSTGRES_DB", "photointel"),
            ).render_as_string(hide_password=False)
            with psycopg.connect(target, autocommit=True, connect_timeout=5) as admin:
                admin.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
                )
                database_created = True
                client: Any = None
                try:
                    client = boto3.client(
                        "s3",
                        endpoint_url=environment["STORAGE_ENDPOINT"],
                        aws_access_key_id=environment["STORAGE_ACCESS_KEY"],
                        aws_secret_access_key=environment["STORAGE_SECRET_KEY"],
                        region_name="us-east-1",
                        config=Config(
                            connect_timeout=5,
                            read_timeout=10,
                            retries={"total_max_attempts": 2},
                            s3={"addressing_style": "path"},
                        ),
                    )
                    client.create_bucket(Bucket=bucket)
                    bucket_created = True
                    client.delete_bucket_policy(Bucket=bucket)
                    subprocess.run(
                        [
                            sys.executable,
                            "-m",
                            "alembic",
                            "-c",
                            "infra/migrations/alembic.ini",
                            "upgrade",
                            "head",
                        ],
                        cwd=ROOT,
                        env=environment,
                        check=True,
                    )
                    child = subprocess.Popen(
                        ["bash", "infra/scripts/run-e2e.sh"],
                        cwd=ROOT,
                        env=environment,
                        start_new_session=True,
                    )
                    previous: dict[int, Any] = {}

                    def forward(signum: int, _frame: Any) -> None:
                        with suppress(ProcessLookupError):
                            os.killpg(child.pid, signum)

                    for signum in (signal.SIGINT, signal.SIGTERM):
                        previous[signum] = signal.signal(signum, forward)
                    try:
                        result = child.wait()
                    finally:
                        for restored_signal, handler in previous.items():
                            signal.signal(restored_signal, handler)
                finally:
                    try:
                        if bucket_created:
                            remove_bucket(client, bucket)
                            report["bucket_removed"] = True
                    finally:
                        if database_created:
                            admin.execute(
                                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                                "WHERE datname=%s AND pid<>pg_backend_pid()",
                                (database,),
                            )
                            admin.execute(
                                sql.SQL("DROP DATABASE {}").format(
                                    sql.Identifier(database)
                                )
                            )
                            report["database_removed"] = True
    except Exception as error:
        # Driver exceptions can include URLs. Keep all credential values out of output.
        print(
            f"Local E2E failed ({type(error).__name__}); "
            "check local services and reports.",
            file=sys.stderr,
        )
        result = 1
    finally:
        report.update({"finished_at": datetime.now(UTC).isoformat(), "exit_code": result})
        (ROOT / "reports").mkdir(exist_ok=True)
        (ROOT / "reports/e2e-local-latest.json").write_text(
            json.dumps(report, indent=2) + "\n",
            encoding="utf-8",
        )
    return result


if __name__ == "__main__":
    raise SystemExit(run())
