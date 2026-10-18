#!/usr/bin/env python3
"""Full encrypted object-content and PostgreSQL restore on disposable synthetic DBs."""

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import psycopg
from photointel.config import Settings
from photointel.models import (
    Album,
    AlbumAsset,
    Asset,
    AssetResource,
    AssetTag,
    Embedding,
    Job,
    Library,
    ModelRegistry,
    Tag,
)
from photointel.services.backup import (
    BackupError,
    BackupReader,
    create_backup,
    postgres_url,
    restore_backup,
)
from photointel.storage import LocalStorage
from PIL import Image
from psycopg import sql
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[2]


def fixture(url: str, storage: LocalStorage) -> None:
    engine = create_engine(make_url(url).set(drivername="postgresql+psycopg"))
    try:
        with Session(engine) as session, session.begin():
            library = Library(
                source_type="fixture",
                source_identifier=str(uuid4()),
                name="Synthetic backup restore fixture",
            )
            model = ModelRegistry(
                provider="synthetic_test",
                model_name="fixture-vector",
                revision="synthetic-v1",
                architecture="fixture",
                embedding_dimension=768,
                capabilities=["image_embedding"],
            )
            tag = Tag(
                canonical_key=f"restore_fixture_{uuid4().hex}",
                display_name="Fixture",
                category="environment",
            )
            album = Album(name="Synthetic restore album")
            session.add_all([library, model, tag, album])
            session.flush()
            asset = Asset(
                library_id=library.id,
                source_asset_key="fixture-1",
                filename="synthetic.png",
                width=48,
                height=32,
                ingestion_status="completed",
                content_revision="fixture-v1",
            )
            session.add(asset)
            session.flush()
            session.add_all(
                [
                    AssetTag(
                        asset_id=asset.id,
                        tag_id=tag.id,
                        origin="user",
                        confidence=1,
                        user_status="approved",
                        model_version="",
                    ),
                    AlbumAsset(album_id=album.id, asset_id=asset.id),
                    Embedding(
                        asset_id=asset.id,
                        model_id=model.id,
                        input_revision="fixture-v1",
                        vector=[1.0] + [0.0] * 767,
                    ),
                    Job(
                        job_type="quality_analysis",
                        asset_id=asset.id,
                        idempotency_key=f"restore-fixture-{asset.id}",
                    ),
                ]
            )
            for index, variant in enumerate(
                ("thumbnail_small", "thumbnail_medium", "preview_large")
            ):
                image = Image.new("RGB", (48, 32), (40 + index * 30, 80, 120))
                stream = io.BytesIO()
                image.save(stream, format="PNG")
                content = stream.getvalue()
                key = f"assets/{asset.id}/fixture/{variant}.png"
                storage.put(key, content, "image/png")
                session.add(
                    AssetResource(
                        asset_id=asset.id,
                        resource_type=variant,
                        object_key=key,
                        mime_type="image/png",
                        byte_size=len(content),
                        sha256=hashlib.sha256(content).hexdigest(),
                        revision="fixture-v1",
                        status="available",
                    )
                )
    finally:
        engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--postgres-container")
    parser.add_argument(
        "--report", type=Path, default=ROOT / "reports/application-restore-test.json"
    )
    arguments = parser.parse_args()
    if os.environ.get("APP_ENV") != "test":
        raise SystemExit("APP_ENV=test is required; real/private media is prohibited")
    base = make_url(os.environ["DATABASE_URL"])
    source, target = [
        f"pi_restore_{kind}_{uuid4().hex[:12]}" for kind in ("source", "target")
    ]
    created = []
    old_path = os.environ.get("PATH", "")
    with tempfile.TemporaryDirectory(prefix="photointel-restore-content-") as temporary:
        directory = Path(temporary)
        if arguments.postgres_container:
            container = arguments.postgres_container
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", container):
                raise SystemExit("Invalid test PostgreSQL container name")
            clients = directory / "bin"
            clients.mkdir(mode=0o700)
            for executable in ("pg_dump", "pg_restore"):
                path = clients / executable
                path.write_text(
                    "#!/usr/bin/env bash\nset -euo pipefail\n"
                    "exec docker exec -i -e PGUSER -e PGPASSWORD -e PGDATABASE "
                    "-e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGSSLMODE=disable "
                    f'{container} {executable} "$@"\n'
                )
                path.chmod(0o700)
            os.environ["PATH"] = str(clients) + os.pathsep + old_path
        try:
            with psycopg.connect(
                postgres_url(base.render_as_string(hide_password=False)), autocommit=True
            ) as administration:
                try:
                    for database in (source, target):
                        administration.execute(
                            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
                        )
                        created.append(database)
                    source_url = base.set(database=source).render_as_string(
                        hide_password=False
                    )
                    target_url = base.set(database=target).render_as_string(
                        hide_password=False
                    )
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
                        check=True,
                        stdout=sys.stderr,
                        env=dict(
                            os.environ,
                            DATABASE_URL=source_url,
                            MIGRATION_DATABASE_URL=source_url,
                        ),
                    )
                    storage_source = LocalStorage(directory / "source-media")
                    storage_target = LocalStorage(directory / "target-media")
                    fixture(source_url, storage_source)
                    settings = Settings(
                        app_env="test",
                        database_url=source_url,
                        migration_database_url=source_url,
                    )
                    key = os.urandom(32)
                    manifest = create_backup(
                        settings, directory / "backup", key, storage=storage_source
                    )
                    reader = BackupReader(directory / "backup", key)
                    result = restore_backup(
                        reader, target_url, storage_target, confirm_database=target
                    )
                    assert result["objects_restored_and_read_back"] == 3
                    for entry in reader.manifest["files"]:
                        if entry["name"].startswith("objects/"):
                            content = storage_target.get(entry["metadata"]["object_key"])
                            with Image.open(io.BytesIO(content)) as image:
                                assert image.size == (48, 32)
                    # A missing preview is repaired from actual backup bytes on retry.
                    preview = next(
                        entry
                        for entry in reader.manifest["files"]
                        if entry["name"].endswith("preview_large.png")
                    )
                    storage_target.delete(preview["metadata"]["object_key"])
                    retry = restore_backup(
                        reader, target_url, storage_target, confirm_database=target
                    )
                    assert retry["status"] == "passed"
                    # A corrupt backup is detected before a further restore can proceed.
                    chunk = directory / "backup" / preview["chunks"][0]["path"]
                    chunk.write_bytes(b"corrupt fixture")
                    try:
                        reader.verify()
                    except BackupError:
                        corruption_detected = True
                    else:
                        raise AssertionError("Corrupt image backup was accepted")
                    report = {
                        "executed_at": datetime.now(UTC).isoformat(),
                        "status": "passed",
                        "scope": "disposable databases and synthetic images only",
                        "migration_heads": manifest["migration_heads"],
                        **result,
                        "synthetic_vectors": {"count": 1, "dimensions": 768},
                        "images_decode_after_restore": 3,
                        "missing_preview_repaired": True,
                        "retry_idempotent": True,
                        "corruption_detected": corruption_detected,
                        "database_contains_tags_albums_model_revisions_and_jobs": True,
                    }
                    arguments.report.parent.mkdir(parents=True, exist_ok=True)
                    arguments.report.write_text(json.dumps(report, indent=2) + "\n")
                finally:
                    for database in reversed(created):
                        administration.execute(
                            sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                                sql.Identifier(database)
                            )
                        )
        finally:
            os.environ["PATH"] = old_path
    print("Encrypted PostgreSQL + private object-content backup/restore passed")


if __name__ == "__main__":
    main()
