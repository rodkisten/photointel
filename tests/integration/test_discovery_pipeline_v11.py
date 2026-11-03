"""Real PostgreSQL, encrypted manifests and private objects; Apple is controlled.

This does not assert real iCloud access. Every source image is procedurally generated.
"""

import asyncio
import base64
import io
import os
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from photointel.config import Settings
from photointel.database import Base
from photointel.errors import AppError
from photointel.models import Asset, AssetResource, DiscoveryManifest, DiscoveryScan, Job
from photointel.services import discovery
from photointel.services.ingestion import RemoteAsset
from photointel.services.media import process_asset
from photointel.storage import LocalStorage
from PIL import Image
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def pipeline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    url = os.getenv("DATABASE_URL", "")
    if not url.startswith("postgresql+asyncpg://"):
        pytest.skip("Requires explicit disposable PostgreSQL DATABASE_URL")
    schema = f"test_discovery_{uuid4().hex}"
    administrative = create_async_engine(url)
    async with administrative.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        url,
        connect_args={"server_settings": {"search_path": f"{schema},public"}},
        pool_size=8,
        max_overflow=0,
        execution_options={"schema_translate_map": {None: schema}},
    )
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(discovery, "SessionLocal", factory)
    storage = LocalStorage(tmp_path / "private")
    monkeypatch.setattr(discovery, "get_storage", lambda: storage)
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    settings = Settings(
        app_env="test",
        icloud_enabled=True,
        icloud_account=f"synthetic-{uuid4()}@example.invalid",
        icloud_library="PrimarySync",
        icloud_session_directory=tmp_path / "session",
        icloud_download_directory=tmp_path / "downloads",
        temp_directory=tmp_path / "temp",
        icloud_session_key=base64.b64encode(b"f" * 32).decode(),
        catalog_asset_limit=10000,
    )
    image = Image.new("RGB", (24, 24), (33, 80, 112))
    stream = io.BytesIO()
    image.save(stream, format="JPEG")
    content = stream.getvalue()

    class ControlledAdapter:
        photos: list = []
        offsets: list[int] = []
        fail_number: int | None = None
        fail_discovery_after: int | None = None
        download_calls: list[str] = []

        def __init__(self, settings):
            self.settings = settings

        def connect(self):
            return ["PrimarySync"]

        def assets(self, offset=0):
            type(self).offsets.append(offset)
            for index, photo in enumerate(type(self).photos[offset:], start=offset):
                if index == type(self).fail_discovery_after:
                    raise ConnectionError("Controlled interrupted discovery")
                yield photo

        def describe(self, photo):
            return RemoteAsset(
                source_key=photo.id,
                filename=f"{photo.id}.jpg",
                media_type="image",
                original_size=len(content),
                captured_at=None,
                added_at=None,
                dimensions=(24, 24),
                version=self.representation(photo),
                representation_size=len(content),
                representation_checksum=photo.id,
                live_resources=(),
            )

        def representation(self, photo):
            return SimpleNamespace(size=len(content), checksum=photo.id, url="not-logged")

        def download(self, photo, version, target):
            type(self).download_calls.append(photo.id)
            failed_number = type(self).fail_number
            if failed_number is not None and photo.id == f"photo-{failed_number:04d}":
                raise AppError(
                    "ICLOUD_ASSET_UNAVAILABLE", "Controlled missing asset", 503
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            return len(content)

    def photos(count):
        return [
            SimpleNamespace(
                id=f"photo-{index:04d}",
                _master_record={
                    "recordName": f"photo-{index:04d}",
                    "signed": "https://signed.invalid/private?token=never-plaintext",
                },
                _asset_record={"recordName": f"asset-{index:04d}"},
            )
            for index in range(1, count + 1)
        ]

    monkeypatch.setattr(discovery, "ICloudAdapter", ControlledAdapter)
    try:
        yield factory, settings, ControlledAdapter, photos, storage
    finally:
        await engine.dispose()
        async with administrative.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await administrative.dispose()


async def authorized_job(factory, settings, count):
    from photointel.services.import_policy import authorize_import

    async with factory() as session:
        job = Job(
            job_type="icloud_discovery",
            idempotency_key=f"discovery-test-{uuid4()}",
            payload={"authorization": authorize_import(settings, count, count > 100)},
        )
        session.add(job)
        await session.commit()
        return job.id


@pytest.mark.parametrize("count", [100, 500, 1000])
async def test_authorized_execution_limit_is_not_silently_clamped(pipeline, count):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(count)
    job_id = await authorized_job(factory, settings, count)
    result = await discovery.discover_icloud(
        settings, count, job_id=job_id, mode="backfill"
    )
    assert result["execution_limit"] == count
    assert result["discovered"] == count
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == count
        assert (
            await session.scalar(select(func.count()).select_from(DiscoveryManifest))
            == count
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.job_type == "media_download")
            )
            == count
        )
        scan = await session.get(DiscoveryScan, UUID(result["scan_id"]))
        assert scan.source_cursor["offset"] == count
        assert "never-plaintext" not in str(
            (await session.scalars(select(DiscoveryManifest.snapshot))).all()
        )


async def test_500_assets_one_failure_keeps_499_downloaded_and_checkpoint(pipeline):
    factory, settings, adapter, photos, storage = pipeline
    adapter.photos = photos(500)
    adapter.fail_number = 137
    job_id = await authorized_job(factory, settings, 500)
    result = await discovery.discover_icloud(
        settings, 500, job_id=job_id, mode="backfill"
    )
    async with factory() as session:
        assets = list(
            (await session.scalars(select(Asset).order_by(Asset.source_asset_key))).all()
        )
    semaphore = asyncio.Semaphore(4)

    async def download(asset):
        async with semaphore:
            try:
                await discovery.download_discovered_asset(asset.id, settings)
                async with factory() as session:
                    current = await session.get(Asset, asset.id)
                    await process_asset(session, current, settings)
                    await session.commit()
                await discovery.mark_asset_processing(asset.id, "completed")
                return True
            except AppError:
                return False

    outcomes = await asyncio.gather(*(download(asset) for asset in assets))
    assert sum(outcomes) == 499
    async with factory() as session:
        failed = await session.scalar(
            select(DiscoveryManifest).where(DiscoveryManifest.source_key == "photo-0137")
        )
        assert failed.status == "retrying"
        assert failed.failure_category == "remote_asset_unavailable"
        assert failed.attempts == 1
        assert (
            await session.scalar(
                select(func.count())
                .select_from(DiscoveryManifest)
                .where(DiscoveryManifest.status == "completed")
            )
            == 499
        )
        scan = await session.get(DiscoveryScan, UUID(result["scan_id"]))
        assert scan.source_cursor["offset"] == 500
        failed_id = failed.asset_id
    async with factory() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Asset)
                .where(Asset.ingestion_status == "completed")
            )
            == 499
        )
    adapter.fail_number = None
    await discovery.download_discovered_asset(failed_id, settings)
    async with factory() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(AssetResource)
                .where(AssetResource.resource_type == "source_download")
            )
            == 500
        )
        assert await session.scalar(select(func.count()).select_from(Asset)) == 500
        failed = await session.scalar(
            select(DiscoveryManifest).where(DiscoveryManifest.asset_id == failed_id)
        )
        assert failed.status == "downloaded" and failed.attempts == 2
    assert len(adapter.download_calls) == 501
    assert adapter.download_calls.count("photo-0137") == 2
    for asset in assets:
        await discovery.download_discovered_asset(asset.id, settings)
    assert len(adapter.download_calls) == 501
    assert len(list(storage.directory.rglob("*.image"))) == 500


async def test_expired_icloud_media_url_is_refreshed_once(pipeline, monkeypatch):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(1)
    await discovery.discover_icloud(settings, 1, mode="backfill")

    original_download = adapter.download
    attempts: list[str] = []
    refreshed_ranks: list[int | None] = []

    def expiring_download(self, photo, version, target):
        attempts.append(photo.id)
        if len(attempts) == 1:
            raise AppError(
                "ICLOUD_ASSET_UNAVAILABLE",
                "URL temporária da foto expirou (HTTP 410)",
                503,
            )
        return original_download(self, photo, version, target)

    def refresh(self, source_key, rank=None):
        refreshed_ranks.append(rank)
        return next((photo for photo in self.photos if photo.id == source_key), None)

    monkeypatch.setattr(adapter, "download", expiring_download)
    monkeypatch.setattr(adapter, "fresh_photo", refresh, raising=False)

    async with factory() as session:
        asset = await session.scalar(select(Asset))
        assert asset is not None
        asset_id = asset.id
        manifest = await session.scalar(select(DiscoveryManifest))
        assert manifest.snapshot["remote_rank"] == 0

    result = await discovery.download_discovered_asset(asset_id, settings)
    assert result["downloaded"] is True
    assert attempts == ["photo-0001", "photo-0001"]
    assert refreshed_ranks == [0]
    async with factory() as session:
        manifest = await session.scalar(select(DiscoveryManifest))
        assert manifest.status == "downloaded" and manifest.attempts == 1


async def test_refresh_refuses_changed_icloud_representation(pipeline, monkeypatch):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(1)
    await discovery.discover_icloud(settings, 1, mode="backfill")

    def expired(self, photo, version, target):
        raise AppError("ICLOUD_ASSET_UNAVAILABLE", "Apple (HTTP 410)", 503)

    def changed(self, source_key, rank=None):
        return SimpleNamespace(id=source_key)

    def changed_version(self, photo):
        return SimpleNamespace(size=999, checksum="different", url="not-logged")

    monkeypatch.setattr(adapter, "download", expired)
    monkeypatch.setattr(adapter, "fresh_photo", changed, raising=False)
    monkeypatch.setattr(adapter, "representation", changed_version)

    async with factory() as session:
        asset_id = (await session.scalar(select(Asset))).id
    with pytest.raises(AppError) as caught:
        await discovery.download_discovered_asset(asset_id, settings)
    assert caught.value.code == "INVALID_REPRESENTATION"
    async with factory() as session:
        manifest = await session.scalar(select(DiscoveryManifest))
        assert manifest.status == "quarantined"
        assert manifest.failure_category == "invalid_representation"


async def test_interruption_preserves_manifest_cursor_and_resume_anchors(pipeline):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(120)
    adapter.fail_discovery_after = 37
    with pytest.raises(ConnectionError):
        await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        scan = await session.scalar(select(DiscoveryScan))
        assert scan.status == "interrupted" and scan.source_cursor["offset"] == 37
        assert await session.scalar(select(func.count()).select_from(Asset)) == 37
    adapter.fail_discovery_after = None
    result = await discovery.discover_icloud(settings, 100, mode="backfill")
    assert result["discovered"] == 83
    assert result["next_offset"] == 120
    assert adapter.offsets == [0, 5, 37]
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 120
        assert (
            await session.scalar(select(func.count()).select_from(DiscoveryManifest))
            == 120
        )
        assert await session.scalar(select(func.count()).select_from(Job)) == 120


async def test_source_shift_restarts_discovery_without_duplicate_jobs(pipeline):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(120)
    await discovery.discover_icloud(settings, 100, mode="backfill")
    adapter.photos.insert(
        0,
        SimpleNamespace(
            id="new-photo", _master_record={"recordName": "new-photo"}, _asset_record={}
        ),
    )
    await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 101
        assert await session.scalar(select(func.count()).select_from(Job)) == 101
        scan = await session.scalar(select(DiscoveryScan))
        assert scan.source_cursor["source_shift_detected"] is True


async def test_incremental_head_overlaps_known_assets_without_clamping_new_500(pipeline):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(500)
    job_id = await authorized_job(factory, settings, 500)
    first = await discovery.discover_icloud(settings, 500, job_id=job_id)
    assert first["discovered"] == 500 and first["imported"] == 500
    second = await discovery.discover_icloud(settings, 100)
    assert second["discovered"] == 100 and second["imported"] == 0
    assert adapter.offsets == [0, 0]
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 500
        scans = list((await session.scalars(select(DiscoveryScan))).all())
        assert len(scans) == 2
        assert all(scan.status == "completed" for scan in scans)


async def test_one_malformed_asset_is_quarantined_and_discovery_continues(
    pipeline,
    monkeypatch: pytest.MonkeyPatch,
):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(5)
    describe = adapter.describe

    def malformed(self, photo):
        if photo.id == "photo-0003":
            raise KeyError("Controlled unsupported representation")
        return describe(self, photo)

    monkeypatch.setattr(adapter, "describe", malformed)
    result = await discovery.discover_icloud(settings, 100, mode="backfill")
    assert result["discovered"] == 5 and result["failed"] == 1
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 5
        assert await session.scalar(select(func.count()).select_from(Job)) == 4
        quarantined = await session.scalar(
            select(DiscoveryManifest).where(DiscoveryManifest.source_key == "photo-0003")
        )
        assert quarantined.status == "quarantined"
        assert quarantined.failure_category == "invalid_representation"


async def test_external_io_has_no_checked_out_database_connection(
    pipeline,
    monkeypatch: pytest.MonkeyPatch,
):
    factory, settings, adapter, photos, storage = pipeline
    adapter.photos = photos(1)
    pool = factory.kw["bind"].pool
    checked = []

    def external_wrapper(original):
        def call(*args, **kwargs):
            checked.append(pool.checkedout())
            assert pool.checkedout() == 0, "External I/O held a PostgreSQL connection"
            return original(*args, **kwargs)

        return call

    for method in ("connect", "describe", "download"):
        monkeypatch.setattr(adapter, method, external_wrapper(getattr(adapter, method)))
    monkeypatch.setattr(storage, "put", external_wrapper(storage.put))
    result = await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        asset = await session.scalar(select(Asset))
        asset_id = asset.id
    await discovery.download_discovered_asset(asset_id, settings)
    async with factory() as session:
        asset = await session.get(Asset, asset_id)
        await process_asset(session, asset, settings)
        await session.commit()
    assert result["discovered"] == 1
    assert len(checked) >= 8
    assert set(checked) == {0}


async def test_same_cloud_run_job_retry_cannot_exceed_its_original_limit(pipeline):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(180)
    job_id = await authorized_job(factory, settings, 100)
    adapter.fail_discovery_after = 37
    with pytest.raises(ConnectionError):
        await discovery.discover_icloud(settings, 100, job_id=job_id, mode="backfill")
    adapter.fail_discovery_after = None
    second = await discovery.discover_icloud(
        settings, 100, job_id=job_id, mode="backfill"
    )
    assert second["discovered"] == 63
    assert second["authorized_job_discovered"] == 100
    third = await discovery.discover_icloud(settings, 100, job_id=job_id, mode="backfill")
    assert third["discovered"] == 0
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 100
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.job_type == "media_download")
            )
            == 100
        )
        job = await session.get(Job, job_id)
        assert job.payload["discovery_progress"]["discovered"] == 100


async def test_download_byte_budget_quarantines_explicitly_and_is_not_reserved_twice(
    pipeline,
):
    factory, settings, adapter, photos, _ = pipeline
    settings = settings.model_copy(update={"max_run_download_bytes": 1024})
    adapter.photos = photos(5)
    job_id = await authorized_job(factory, settings, 100)
    first = await discovery.discover_icloud(settings, 100, job_id=job_id, mode="backfill")
    assert first["discovered"] == 5 and first["failed"] == 4
    async with factory() as session:
        manifests = list((await session.scalars(select(DiscoveryManifest))).all())
        assert sum(row.status == "quarantined" for row in manifests) == 4
        assert sum(row.status == "queued" for row in manifests) == 1
        assert all(
            row.last_error == "DOWNLOAD_BUDGET_EXCEEDED"
            for row in manifests
            if row.status == "quarantined"
        )
        job = await session.get(Job, job_id)
        reserved = job.payload["download_budget"]["reserved_bytes"]
        assert 0 < reserved <= 1024
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.job_type == "media_download")
            )
            == 1
        )
    await discovery.discover_icloud(settings, 100, job_id=job_id, mode="backfill")
    async with factory() as session:
        job = await session.get(Job, job_id)
        assert job.payload["download_budget"]["reserved_bytes"] == reserved


async def test_explicit_verified_backfill_chains_finite_batches_to_exact_target(
    pipeline,
    monkeypatch: pytest.MonkeyPatch,
):
    from photointel.models import DispatchOutbox, JobBatch
    from photointel.services.import_policy import authorize_import

    factory, settings, adapter, photos, _ = pipeline
    settings = settings.model_copy(
        update={"database_profile": "full", "execution_platform": "cloud_run"}
    )
    adapter.photos = photos(300)
    release_sha = "a" * 40
    monkeypatch.setattr(
        "photointel.services.release.get_release_manifest",
        lambda: {"git_sha": release_sha, "provenance_status": "identified"},
    )

    async def passed_gates(session):
        return {"items": [{"id": "F", "status": "passed"}]}

    monkeypatch.setattr("photointel.services.verification.gate_status", passed_gates)
    authorization = authorize_import(settings, 100, False)
    async with factory() as session:
        batch = JobBatch(name="Controlled full backfill")
        session.add(batch)
        await session.flush()
        job = Job(
            job_type="icloud_discovery",
            batch_id=batch.id,
            idempotency_key=f"approved-backfill-{uuid4()}",
            payload={
                "source": "icloud",
                "mode": "backfill",
                "authorization": authorization,
                "backfill_authorization": {
                    "target_assets": 250,
                    "release_sha": release_sha,
                    "authorized_by": "fixture-operator",
                    "approved_at": "2026-10-18T12:00:00Z",
                    "authorization": authorization,
                },
            },
        )
        session.add(job)
        await session.commit()
        job_id, batch_id = job.id, batch.id
    results = []
    while job_id:
        async with factory() as session:
            job = await session.get(Job, job_id)
            requested = job.payload["authorization"]["requested_batch_limit"]
        result = await discovery.discover_icloud(
            settings, requested, job_id=job_id, batch_id=batch_id, mode="backfill"
        )
        results.append(result)
        job_id = (
            UUID(result["next_backfill_job_id"])
            if result["next_backfill_job_id"]
            else None
        )
    assert [row["discovered"] for row in results] == [100, 100, 50]
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 250
        assert await session.scalar(select(func.count()).select_from(DispatchOutbox)) == 2
        assert (
            await session.scalar(
                select(func.count())
                .select_from(Job)
                .where(Job.job_type == "icloud_discovery")
            )
            == 3
        )
        batch = await session.get(JobBatch, batch_id)
        assert len(batch.counters["download_budget"]["executions"]) == 3


async def test_expired_discovery_owner_cannot_overwrite_new_scan_state(
    pipeline,
    monkeypatch: pytest.MonkeyPatch,
):
    from photointel.models import DurableLease

    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(1)
    loop = asyncio.get_running_loop()

    async def take_ownership():
        async with factory() as session:
            lease = await session.scalar(
                select(DurableLease)
                .where(DurableLease.key.startswith("discovery:"))
                .with_for_update()
            )
            lease.owner = "new-discovery-owner"
            lease.fence_token += 1
            await session.commit()

    def old_owner_fails(self, photo):
        asyncio.run_coroutine_threadsafe(take_ownership(), loop).result(timeout=10)
        raise AppError("ICLOUD_ACCESS_DENIED", "Controlled stale worker failure", 503)

    monkeypatch.setattr(adapter, "describe", old_owner_fails)
    with pytest.raises(discovery.LeaseLost):
        await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        scan = await session.scalar(select(DiscoveryScan))
        assert scan.status == "discovering"
        assert scan.last_error is None
        lease = await session.scalar(
            select(DurableLease).where(DurableLease.key.startswith("discovery:"))
        )
        assert lease.owner == "new-discovery-owner"


async def test_catalog_admission_counts_once_and_rolls_back_excess_asset(pipeline):
    from photointel.models import Setting
    from photointel.services.ingestion import CATALOG_ADMISSION_KEY
    from sqlalchemy import event

    factory, settings, adapter, photos, _ = pipeline
    settings = settings.model_copy(update={"catalog_asset_limit": 20})
    adapter.photos = photos(20)
    count_queries = []

    def record_count(connection, cursor, statement, parameters, context, executemany):
        normalized = statement.lower()
        if "count(" in normalized and ".assets" in normalized:
            count_queries.append(statement)

    engine = factory.kw["bind"]
    event.listen(engine.sync_engine, "before_cursor_execute", record_count)
    try:
        first = await discovery.discover_icloud(settings, 100, mode="backfill")
        assert first["discovered"] == 20
        assert len(count_queries) == 1
        adapter.photos = photos(21)
        with pytest.raises(AppError, match="Limite do catálogo"):
            await discovery.discover_icloud(settings, 100, mode="backfill")
        assert len(count_queries) == 2
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_count)
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 20
        ledger = await session.get(Setting, CATALOG_ADMISSION_KEY)
        assert ledger.value["count"] == 20


async def test_concurrent_catalog_admissions_cannot_exceed_profile_limit(pipeline):
    from photointel.models import Setting
    from photointel.services.ingestion import (
        CATALOG_ADMISSION_KEY,
        _library,
        _upsert_asset,
    )

    factory, _, _, _, _ = pipeline
    async with factory() as session:
        library = await _library(session, "fixture", "quota-regression", "Generated")
        library_id = library.id
        await session.commit()

    async def attempt(source_key):
        async with factory() as session:
            library = await session.get(discovery.Library, library_id)
            try:
                await _upsert_asset(
                    session,
                    library,
                    source_key=source_key,
                    filename=f"{source_key}.jpg",
                    revision="generated-revision",
                    metadata={"fixture": True},
                    size=1,
                    enqueue=False,
                    catalog_limit=1,
                )
                await session.commit()
                return True
            except AppError:
                await session.rollback()
                return False

    assert sum(await asyncio.gather(attempt("one"), attempt("two"))) == 1
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 1
        ledger = await session.get(Setting, CATALOG_ADMISSION_KEY)
        assert ledger.value["count"] == 1


@pytest.mark.parametrize("damage", ["equal_size_corruption", "missing_object"])
async def test_invalid_persisted_source_is_repaired_without_touching_other_assets(
    pipeline, damage
):
    from photointel.models import ObjectIntent

    factory, settings, adapter, photos, storage = pipeline
    adapter.photos = photos(2)
    await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        assets = list(
            (await session.scalars(select(Asset).order_by(Asset.source_asset_key))).all()
        )
    for asset in assets:
        await discovery.download_discovered_asset(asset.id, settings)
    async with factory() as session:
        first = await session.scalar(
            select(AssetResource).where(AssetResource.asset_id == assets[0].id)
        )
        second = await session.scalar(
            select(AssetResource).where(AssetResource.asset_id == assets[1].id)
        )
        first_key, second_key = first.object_key, second.object_key
    original, unrelated = storage.get(first_key), storage.get(second_key)
    if damage == "missing_object":
        storage.delete(first_key)
    else:
        storage.put(first_key, b"x" * len(original), "application/octet-stream")
    await discovery.download_discovered_asset(assets[0].id, settings)
    assert storage.get(first_key) == original
    assert storage.get(second_key) == unrelated
    assert len(adapter.download_calls) == 3
    async with factory() as session:
        asset = await session.get(Asset, assets[0].id)
        assert (
            asset.source_metadata["last_source_incident"]["code"]
            == "PERSISTED_SOURCE_INTEGRITY_FAILED"
        )
        intent = await session.scalar(
            select(ObjectIntent).where(ObjectIntent.object_key == first_key)
        )
        assert intent.status == "committed"
        assert (
            await session.scalar(
                select(func.count())
                .select_from(AssetResource)
                .where(AssetResource.status == "available")
            )
            == 2
        )
    await discovery.download_discovered_asset(assets[0].id, settings)
    assert len(adapter.download_calls) == 3


async def test_storage_outage_does_not_invalidate_persisted_source(
    pipeline, monkeypatch: pytest.MonkeyPatch
):
    factory, settings, adapter, photos, storage = pipeline
    adapter.photos = photos(1)
    await discovery.discover_icloud(settings, 100, mode="backfill")
    async with factory() as session:
        asset = await session.scalar(select(Asset))
        asset_id = asset.id
    await discovery.download_discovered_asset(asset_id, settings)

    def unavailable(key):
        raise AppError("STORAGE_UNAVAILABLE", "Controlled provider outage", 503)

    monkeypatch.setattr(storage, "open_stream", unavailable)
    with pytest.raises(AppError, match="Controlled provider outage"):
        await discovery.download_discovered_asset(asset_id, settings)
    async with factory() as session:
        resource = await session.scalar(
            select(AssetResource).where(AssetResource.asset_id == asset_id)
        )
        assert resource.status == "available"
    assert len(adapter.download_calls) == 1


async def test_catalog_ledger_refreshes_after_another_session_admits_an_asset(pipeline):
    from photointel.models import Setting
    from photointel.services.ingestion import (
        CATALOG_ADMISSION_KEY,
        _library,
        _upsert_asset,
    )

    factory, _, _, _, _ = pipeline

    async def admit(session, library, source_key):
        await _upsert_asset(
            session,
            library,
            source_key=source_key,
            filename=f"{source_key}.jpg",
            revision="generated-revision",
            metadata={"fixture": True},
            size=1,
            enqueue=False,
            catalog_limit=2,
        )
        await session.commit()

    async with factory() as first:
        library = await _library(first, "fixture", "shared-quota", "Generated")
        await first.commit()
        await admit(first, library, "one")
        # Keep this ORM row in the identity map, as a fixture batch does.
        ledger = await first.get(Setting, CATALOG_ADMISSION_KEY)
        assert ledger.value["count"] == 1
        await first.commit()
        async with factory() as second:
            await admit(second, library, "two")
        with pytest.raises(AppError, match="Limite do catálogo"):
            await admit(first, library, "three")
        await first.rollback()
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Asset)) == 2


async def test_repeated_fixture_import_persists_four_skips_in_its_own_batch(
    pipeline, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from photointel.models import JobBatch, JobEvent
    from photointel.services import ingestion
    from photointel.services.fixtures import generate_fixtures

    factory, settings, _, _, _ = pipeline
    source = tmp_path / "procedural-fixtures"
    generate_fixtures(source, 4)

    async def configured_settings(session):
        return settings

    monkeypatch.setattr(ingestion, "effective_settings", configured_settings)
    async with factory() as session:
        initial = await ingestion.ingest_fixture_directory(
            session, source, limit=4, process_inline=True
        )
        assert initial["imported"] == 4
        await session.commit()
        batch = JobBatch(name="Repeat controlled fixtures")
        session.add(batch)
        await session.commit()
        batch_id = batch.id
        for _ in range(2):
            result = await ingestion.ingest_fixture_directory(
                session, source, limit=4, batch_id=batch_id
            )
            await session.commit()
            assert result["discovered"] == 4 and result["skipped"] == 4
            await session.refresh(batch)
            assert batch.total_assets == 4
            assert (batch.completed, batch.failed, batch.skipped) == (0, 0, 4)
            assert batch.status == "completed"
        assert (
            await session.scalar(
                select(func.count()).select_from(Job).where(Job.batch_id == batch_id)
            )
            == 4
        )
        assert (
            await session.scalar(
                select(func.count())
                .select_from(JobEvent)
                .join(Job, Job.id == JobEvent.job_id)
                .where(Job.batch_id == batch_id, JobEvent.status == "completed")
            )
            == 4
        )


async def test_job_recovery_closes_old_ingestion_attempt_without_touching_current_scan(
    pipeline,
):
    from datetime import timedelta

    from photointel.models import IngestionRun, utcnow
    from photointel.services.ingestion import _library
    from photointel.services.jobs import recover_stale_jobs

    factory, _, _, _, _ = pipeline
    async with factory() as session:
        now = utcnow()
        library = await _library(session, "fixture", "recovered-run", "Generated")
        job = Job(
            job_type="icloud_discovery",
            status="running",
            worker_id="new-owner",
            fence_token=2,
            started_at=now,
            lease_until=now + timedelta(minutes=5),
            idempotency_key=f"recovered-ingestion-{uuid4()}",
        )
        session.add(job)
        await session.flush()
        scan = DiscoveryScan(library_id=library.id, status="discovering")
        old = IngestionRun(job_id=job.id, started_at=now - timedelta(minutes=5))
        current = IngestionRun(job_id=job.id, started_at=now + timedelta(seconds=1))
        already_completed = IngestionRun(
            job_id=job.id, status="completed", started_at=now - timedelta(minutes=10)
        )
        session.add_all([scan, old, current, already_completed])
        await session.commit()
        assert await recover_stale_jobs(session) == 0
        await session.commit()
        await session.refresh(old)
        await session.refresh(current)
        await session.refresh(scan)
        await session.refresh(already_completed)
        assert old.status == "failed" and old.error == "WORKER_INTERRUPTED"
        assert old.finished_at is not None
        assert current.status == "running" and current.finished_at is None
        assert scan.status == "discovering"
        assert already_completed.status == "completed"


@pytest.mark.parametrize(
    ("status", "lease"),
    [("failed", "none"), ("completed", "none"), ("running", "expired")],
)
async def test_interrupted_ingestion_recovery_is_bounded_and_idempotent(
    pipeline, status, lease
):
    from datetime import timedelta

    from photointel.models import IngestionRun, utcnow
    from photointel.services.jobs import recover_interrupted_ingestion_runs

    factory, _, _, _, _ = pipeline
    async with factory() as session:
        now = utcnow()
        job = Job(
            job_type="icloud_discovery",
            status=status,
            lease_until=now - timedelta(seconds=1) if lease == "expired" else None,
            idempotency_key=f"bounded-ingestion-{uuid4()}",
        )
        session.add(job)
        await session.flush()
        session.add_all([IngestionRun(job_id=job.id) for _ in range(2)])
        await session.commit()
        assert await recover_interrupted_ingestion_runs(session, limit=1) == 1
        await session.commit()
        assert (
            await session.scalar(
                select(func.count())
                .select_from(IngestionRun)
                .where(IngestionRun.status == "running")
            )
            == 1
        )
        assert await recover_interrupted_ingestion_runs(session, limit=1) == 1
        await session.commit()
        assert await recover_interrupted_ingestion_runs(session, limit=1) == 0


async def test_contention_does_not_consume_manifest_attempts(
    pipeline, monkeypatch: pytest.MonkeyPatch
):
    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(1)
    await discovery.discover_icloud(settings, 1, mode="backfill")
    async with factory() as session:
        asset = (await session.scalars(select(Asset))).one()

    @asynccontextmanager
    async def occupied(*args, **kwargs):
        raise AppError("RATE_LIMITED", "Shared session busy", 503)
        yield

    monkeypatch.setattr(discovery, "session_directory", occupied)
    with pytest.raises(AppError):
        await discovery.download_discovered_asset(asset.id, settings)

    async with factory() as session:
        manifest = (await session.scalars(select(DiscoveryManifest))).one()
        assert manifest.attempts == 0
        assert manifest.status != "downloading"



async def test_catalog_preview_audit_finds_missing_and_invalid_variants(pipeline):
    from photointel.routers.preview_audit import audit_previews

    factory, settings, adapter, photos, _ = pipeline
    adapter.photos = photos(3)
    await discovery.discover_icloud(settings, 3, mode="backfill")
    async with factory() as session:
        assets = list((await session.scalars(select(Asset).order_by(Asset.id))).all())
        incomplete, complete, awaiting_source = assets
        incomplete.ingestion_status = "completed"
        complete.ingestion_status = "completed"
        failed_job = await session.scalar(
            select(Job).where(Job.asset_id == incomplete.id)
        )
        assert failed_job is not None
        failed_job.status = "failed"
        for kind in ("thumbnail_small", "thumbnail_medium", "preview_large"):
            session.add(AssetResource(
                asset_id=complete.id,
                resource_type=kind,
                revision=complete.representation_revision,
                object_key=f"synthetic/{kind}",
                status="available",
                byte_size=123,
            ))
        session.add(AssetResource(
            asset_id=incomplete.id,
            resource_type="thumbnail_medium",
            revision=incomplete.representation_revision,
            object_key="synthetic/invalid",
            status="failed",
            byte_size=0,
        ))
        await session.commit()

    async with factory() as session:
        report = await audit_previews(session, limit=30, cursor=None)
        found = {item["asset_id"]: item for item in report["items"]}
        assert report["total_assets"] == 3
        assert report["total_issues"] == 1
        assert str(incomplete.id) in found
        assert str(complete.id) not in found
        assert str(awaiting_source.id) not in found
        assert found[str(incomplete.id)]["missing_variants"] == [
            "thumbnail_small", "thumbnail_medium", "preview_large",
        ]
        assert found[str(incomplete.id)]["invalid_variants"] == ["thumbnail_medium"]
        assert found[str(incomplete.id)]["repairable"] is True
