#!/usr/bin/env python3
"""Check session encryption, PostgreSQL and R2; never log in to Apple."""

import json
import os
import subprocess
import tempfile
import sys
from pathlib import Path

from infra.gcp.cloud_cli import run as cloud_run

PROJECT = "photointel"
REGION = "us-central1"
JOB = "photointel-icloud-preflight"
PROBE = """
import asyncio
from sqlalchemy import text
from photointel.config import get_settings
from photointel.database import SessionLocal, engine
from photointel.services.session_store import encryption_key
from photointel.storage import get_storage
async def check():
    try:
        encryption_key(get_settings())
        async with SessionLocal() as session:
            await session.execute(text('SELECT 1'))
        storage = get_storage()
        await asyncio.to_thread(storage.client.head_bucket, Bucket=storage.bucket)
        print('ICLOUD_PREFLIGHT=ready; key, database and storage verified', flush=True)
    except Exception as exc:
        print('ICLOUD_PREFLIGHT=failed; type=' + type(exc).__name__, flush=True)
        raise SystemExit(1)
    finally:
        await engine.dispose()
asyncio.run(check())
"""


def call(arguments, *, required=True):
    result = cloud_run(arguments, project=PROJECT, timeout=240)
    if result.returncode and required:
        raise RuntimeError("Preflight não concluiu; confira IAM e os logs do Job")
    return result


def main():
    worker = json.loads(call([
        "run", "jobs", "describe", "photointel-worker", "--region", REGION,
        "--format=json",
    ]).stdout)
    template = worker["spec"]["template"]["spec"]["template"]["spec"]
    source = template["containers"][0]
    container = {key: source[key] for key in ("image", "env") if key in source}
    container.update(command=["python"], args=["-c", PROBE],
                     resources={"limits": {"cpu": "1", "memory": "512Mi"}})
    document = {
        "apiVersion": "run.googleapis.com/v1", "kind": "Job",
        "metadata": {"name": JOB},
        "spec": {"template": {"spec": {"taskCount": 1, "parallelism": 1,
            "template": {"spec": {"containers": [container],
                "serviceAccountName": template["serviceAccountName"],
                "maxRetries": 0, "timeoutSeconds": "90"}}}}},
    }
    fd, path = tempfile.mkstemp(prefix="photointel-icloud-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(document, stream)
        call(["run", "jobs", "replace", path, "--region", REGION])
        call(["run", "jobs", "execute", JOB, "--region", REGION, "--wait"])
        print("iCloud pronto para login: chave de sessão, PostgreSQL e R2 verificados.")
        print("Nenhuma chamada Apple, importação, GPU ou agendamento executado.")
    finally:
        os.unlink(path)
        call(["run", "jobs", "delete", JOB, "--region", REGION], required=False)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.SubprocessError):
        print("::error::Preflight iCloud falhou. Nenhuma credencial foi exibida.")
        raise SystemExit(1) from None
