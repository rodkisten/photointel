"""Isolated PostgreSQL tests: operator evidence never becomes fabricated live proof."""

import os
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest
from photointel.config import Settings
from photointel.database import Base, get_session
from photointel.main import create_app
from photointel.models import (
    Asset,
    DiscoveryManifest,
    DiscoveryScan,
    DispatchOutbox,
    IngestionRun,
    Job,
    Library,
    VerificationGate,
    utcnow,
)
from photointel.routers import readiness
from photointel.services import verification
from photointel.services.leases import LeaseLost, assert_job_fences
from photointel.storage import LocalStorage
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

pytestmark = pytest.mark.integration
SHA = "7" * 40


@pytest.fixture
async def readiness_api(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[tuple[httpx.AsyncClient, AsyncSession, dict[str, Any], Settings]]:
    url = os.getenv("DATABASE_URL", "")
    if not url.startswith("postgresql+asyncpg://"):
        pytest.skip("Requires explicit disposable PostgreSQL DATABASE_URL")
    schema = f"test_readiness_{uuid4().hex}"
    administration = create_async_engine(url)
    async with administration.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        url,
        connect_args={"server_settings": {"search_path": f"{schema},public"}},
        execution_options={"schema_translate_map": {None: schema}},
        pool_size=2,
        max_overflow=0,
    )
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        release = {"git_sha": SHA, "provenance_status": "identified"}
        monkeypatch.setattr(readiness, "get_release_manifest", lambda: release)
        monkeypatch.setattr(verification, "get_release_manifest", lambda: release)
        storage = LocalStorage(tmp_path / "objects")
        monkeypatch.setattr(readiness, "get_storage", lambda: storage)
        settings = Settings(
            _env_file=None,
            app_env="test",
            auth_mode="local",
            icloud_enabled=True,
            icloud_account="synthetic@example.invalid",
            icloud_library="PrimarySync",
            icloud_session_directory=tmp_path / "session",
            temp_directory=tmp_path / "temp",
            verification_gates_enforced=True,
            catalog_asset_limit=10000,
        )

        async def configuration(session: AsyncSession) -> Settings:
            return settings

        monkeypatch.setattr(readiness, "effective_settings", configuration)
        async with engine.connect() as connection:
            transaction = await connection.begin()
            async with AsyncSession(
                bind=connection,
                expire_on_commit=False,
                join_transaction_mode="create_savepoint",
            ) as session:
                app = create_app()

                async def database() -> AsyncIterator[AsyncSession]:
                    # Production get_session closes/rolls back failed requests.
                    try:
                        yield session
                    except Exception:
                        await session.rollback()
                        raise

                app.dependency_overrides[get_session] = database
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app),
                    base_url="http://localhost",
                ) as client:
                    yield client, session, release, settings
            await transaction.rollback()
    finally:
        await engine.dispose()
        async with administration.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await administration.dispose()


def attestation(gate: str, **changes: Any) -> dict[str, Any]:
    return {
        "gate_id": gate,
        "status": "passed",
        "release_sha": SHA,
        "operator_attestation": True,
        "evidence": ["tests/operator-fixture-protocol.json"],
        **changes,
    }


async def test_gates_require_evidence_prerequisites_and_exact_release(readiness_api):
    client, session, release, _ = readiness_api
    initial = (await client.get("/v1/verification/gates")).json()
    assert initial["full_backfill_unlocked"] is False
    assert (
        await client.patch(
            "/v1/verification/gates",
            json=attestation("B"),
        )
    ).status_code == 409
    assert (
        await client.patch(
            "/v1/verification/gates",
            json=attestation("A", evidence=[]),
        )
    ).status_code == 422
    assert (
        await client.patch(
            "/v1/verification/gates",
            json=attestation("A", release_sha="8" * 40),
        )
    ).status_code == 409
    assert (
        await client.patch(
            "/v1/verification/gates",
            json=attestation("A", operator_attestation=False),
        )
    ).status_code == 422
    for gate in ("A", "B", "C"):
        assert (
            await client.patch(
                "/v1/verification/gates",
                json=attestation(gate),
            )
        ).status_code == 200
    row = await session.get(VerificationGate, "B")
    assert row.release_sha == SHA
    assert row.verified_by == "local-development"
    release["git_sha"] = "9" * 40
    changed = (await client.get("/v1/verification/gates")).json()
    states = {row["id"]: row["status"] for row in changed["items"]}
    assert states["A"] == "not_verified"
    assert states["B"] == "blocked"
    assert changed["full_backfill_unlocked"] is False


async def test_fixture_ingestion_cannot_prove_icloud_or_unlock_real_import(readiness_api):
    client, session, _, _ = readiness_api
    library = Library(
        source_type="fixture", source_identifier="synthetic", name="Fixture"
    )
    session.add(library)
    await session.flush()
    session.add(
        IngestionRun(
            library_id=library.id,
            status="completed",
            discovered=10,
            imported=10,
            finished_at=utcnow(),
        )
    )
    await session.commit()
    response = await client.get("/v1/setup/status")
    assert response.status_code == 200, response.text
    setup = response.json()
    checks = {item["id"]: item for item in setup["checks"]}
    assert checks["icloud"]["state"] == "unverified"
    assert checks["gpu"]["state"] == "not_configured"
    preview = await client.post(
        "/v1/ingestion/preview", json={"source": "icloud", "limit": 100}
    )
    assert preview.status_code == 200
    assert preview.json()["can_start"] is False
    assert preview.json()["gate_error"] is not None
    assert (await client.get("/v1/verification/gates")).json()[
        "full_backfill_unlocked"
    ] is False


async def create_failed_asset(session: AsyncSession, status: str = "retrying"):
    library = Library(source_type="icloud", source_identifier=str(uuid4()), name="Test")
    session.add(library)
    await session.flush()
    asset = Asset(
        library_id=library.id,
        source_asset_key="photo137",
        filename="synthetic137.jpg",
        ingestion_status=status,
        content_revision="r1",
    )
    session.add(asset)
    await session.flush()
    scan = DiscoveryScan(library_id=library.id)
    session.add(scan)
    await session.flush()
    manifest = DiscoveryManifest(
        scan_id=scan.id,
        library_id=library.id,
        asset_id=asset.id,
        source_key=asset.source_asset_key,
        content_revision="r1",
        status=status,
        attempts=2,
        maximum_attempts=5,
        last_error="MEDIA_DOWNLOAD_FAILED",
        failure_category="transient_network_error",
    )
    running = Job(
        asset_id=asset.id,
        job_type="media_download",
        status="running",
        worker_id="old-cloud-run-task",
        fence_token=7,
        attempts=2,
        lease_until=utcnow() + timedelta(minutes=5),
        idempotency_key=f"download:{asset.id}:r1",
    )
    completed = Job(
        asset_id=asset.id,
        job_type="metadata_extract",
        status="completed",
        idempotency_key=f"metadata:{asset.id}:r1",
    )
    session.add_all([manifest, running, completed])
    await session.commit()
    return asset, manifest, running, completed


async def test_quarantine_fences_active_worker_without_deleting_completed_data(
    readiness_api,
):
    client, session, _, _ = readiness_api
    asset, manifest, running, completed = await create_failed_asset(session)
    stale_fence = (running.id, running.worker_id, running.fence_token)
    await assert_job_fences(session, [stale_fence])
    await session.commit()
    response = await client.post(
        f"/v1/ingestion/assets/{asset.id}/quarantine",
        json={"reason": "Operator test"},
    )
    assert response.status_code == 200
    await session.refresh(running)
    await session.refresh(completed)
    await session.refresh(manifest)
    assert running.status == "cancelled"
    assert running.fence_token == 8
    assert running.lease_until is None and running.worker_id is None
    assert completed.status == "completed"
    assert manifest.status == "quarantined"
    with pytest.raises(LeaseLost):
        await assert_job_fences(session, [stale_fence])
    assert await session.get(Asset, asset.id) is not None


async def test_retry_reuses_asset_jobs_and_persists_cloud_dispatch(readiness_api):
    client, session, _, settings = readiness_api
    asset, manifest, running, completed = await create_failed_asset(session)
    await client.post(f"/v1/ingestion/assets/{asset.id}/quarantine", json={})
    settings.execution_platform = "cloud_run"
    response = await client.post(f"/v1/ingestion/assets/{asset.id}/retry", json={})
    assert response.status_code == 200
    await session.refresh(running)
    await session.refresh(manifest)
    assert running.status == "queued" and running.fence_token == 9
    assert running.attempts == 0 and running.error_code is None
    assert manifest.status == "queued" and manifest.attempts == 0
    assert await session.scalar(select(func.count(Job.id))) == 2
    assert await session.scalar(select(func.count(DispatchOutbox.id))) == 1
    assert (
        await client.post(
            f"/v1/ingestion/assets/{asset.id}/retry",
            json={},
        )
    ).status_code == 409
    assert await session.scalar(select(func.count(Job.id))) == 2


async def test_completed_manifest_cannot_be_quarantined_or_retried(readiness_api):
    client, session, _, _ = readiness_api
    asset, _, running, _ = await create_failed_asset(session, status="completed")
    asset_id = asset.id
    for action in ("quarantine", "retry"):
        assert (
            await client.post(
                f"/v1/ingestion/assets/{asset_id}/{action}",
                json={},
            )
        ).status_code == 409
    await session.refresh(running)
    assert running.status == "running" and running.fence_token == 7


@pytest.mark.parametrize("enabled", [False, True])
async def test_setup_works_before_icloud_account_or_library_configuration(
    readiness_api,
    enabled: bool,
):
    client, _, _, settings = readiness_api
    settings.icloud_account = ""
    settings.icloud_library = ""
    settings.icloud_enabled = enabled
    response = await client.get("/v1/setup/status")
    assert response.status_code == 200, response.text
    icloud = next(item for item in response.json()["checks"] if item["id"] == "icloud")
    assert icloud["state"] != "operational"
