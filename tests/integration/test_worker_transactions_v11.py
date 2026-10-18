"""Real committed-connection crash tests; external stages must release SQL leases.

Unlike savepoint-only fixtures, these assertions use independent transactions to
observe committed upload intents and ownership stolen while a worker is outside SQL.
"""

import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.database import SessionLocal
from photointel.models import (
    Asset,
    AssetResource,
    Job,
    Library,
    ObjectIntent,
    utcnow,
)
from photointel.services.jobs import claim_jobs, enqueue_job, heartbeat_many
from photointel.services.leases import LeaseLost, acquire_lease, assert_lease
from photointel.services.media import process_asset, reconcile_orphan_objects
from photointel.storage import LocalStorage
from PIL import Image
from sqlalchemy import delete, func, select, text, update

pytestmark = pytest.mark.integration


@pytest.fixture
async def committed_asset(tmp_path: Path) -> AsyncIterator[tuple[Asset, Settings]]:
    identifier = uuid4()
    settings = Settings(
        _env_file=None,
        app_env="test",
        storage_backend="local",
        temp_directory=tmp_path / "processing",
    )
    path = settings.temp_directory / "fixtures" / "test.jpg"
    path.parent.mkdir(parents=True)
    Image.new("RGB", (80, 60), "green").save(path)
    async with SessionLocal() as session:
        library = Library(
            source_type="fixture",
            source_identifier=str(identifier),
            name="Transaction crash fixture",
        )
        session.add(library)
        await session.flush()
        asset = Asset(
            library_id=library.id,
            source_asset_key="fixture",
            filename="test.jpg",
            content_revision="source-v1",
            representation_revision="old-v1",
            source_metadata={"fixture": True, "cache_relative_path": "test.jpg"},
        )
        session.add(asset)
        await session.commit()
    try:
        yield asset, settings
    finally:
        async with SessionLocal() as session:
            # All rows belong to this synthetic fixture, never user data.
            jobs = select(Job.id).where(Job.asset_id == asset.id)
            await session.execute(
                text(
                    "DELETE FROM job_events WHERE job_id IN "
                    "(SELECT id FROM jobs WHERE asset_id=:asset_id)"
                ),
                {"asset_id": asset.id},
            )
            for table in ("asset_tags", "inference_runs", "embeddings", "asset_metadata"):
                await session.execute(
                    text(f"DELETE FROM {table} WHERE asset_id=:asset_id"),
                    {"asset_id": asset.id},
                )
            await session.execute(
                delete(ObjectIntent).where(ObjectIntent.asset_id == asset.id)
            )
            await session.execute(
                delete(AssetResource).where(AssetResource.asset_id == asset.id)
            )
            await session.execute(
                text(
                    "UPDATE worker_states SET current_job_id=NULL "
                    "WHERE current_job_id IN "
                    "(SELECT id FROM jobs WHERE asset_id=:asset_id)"
                ),
                {"asset_id": asset.id},
            )
            await session.execute(
                text("DELETE FROM durable_leases WHERE key=:key"),
                {"key": f"asset:{asset.id}"},
            )
            await session.execute(delete(Job).where(Job.id.in_(jobs)))
            await session.execute(delete(Asset).where(Asset.id == asset.id))
            await session.execute(delete(Library).where(Library.id == asset.library_id))
            await session.commit()


async def owned_job(asset_id) -> Job:
    async with SessionLocal() as session:
        job = await enqueue_job(
            session,
            "metadata_extract",
            asset_id,
            idempotency_key=f"transaction-test:{uuid4()}",
            priority=999999,
        )
        await session.commit()
        claimed = await claim_jobs(session, "worker-a", 1)
        assert any(row.id == job.id for row in claimed)
        await session.commit()
        return job


async def test_upload_crash_leaves_committed_outbox_and_reconciles_only_managed_keys(
    committed_asset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset, settings = committed_asset
    job = await owned_job(asset.id)
    storage = LocalStorage(tmp_path / "private")
    storage.put("unrelated/keep.jpg", b"not-owned-by-outbox", "image/jpeg")
    original_put = storage.put
    calls = 0
    async with SessionLocal() as session:
        current = await session.get(Asset, asset.id)

        def interrupted_put(key: str, data: bytes, mime: str) -> None:
            nonlocal calls
            assert not session.in_transaction(), "R2 PUT retained a SQL transaction"
            calls += 1
            original_put(key, data, mime)
            raise OSError("simulated process interruption after object upload")

        monkeypatch.setattr(storage, "put", interrupted_put)
        monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
        with pytest.raises(OSError):
            await process_asset(
                session,
                current,
                settings,
                job_fences=[(job.id, "worker-a", job.fence_token)],
            )
        await session.rollback()
    async with SessionLocal() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(AssetResource)
                .where(AssetResource.asset_id == asset.id)
            )
            == 0
        )
        intents = list(
            (
                await session.scalars(
                    select(ObjectIntent).where(ObjectIntent.asset_id == asset.id)
                )
            ).all()
        )
        assert len(intents) == 4 and calls == 1
        assert all(row.status == "pending" for row in intents)
        await session.execute(
            update(Job).where(Job.id == job.id).values(status="failed", lease_until=None)
        )
        await session.execute(
            update(ObjectIntent)
            .where(ObjectIntent.asset_id == asset.id)
            .values(updated_at=utcnow() - timedelta(days=2))
        )
        await session.commit()
        original_exists, original_delete = storage.exists, storage.delete

        def checked_exists(key: str) -> bool:
            assert not session.in_transaction()
            return original_exists(key)

        def checked_delete(key: str) -> None:
            assert not session.in_transaction()
            original_delete(key)

        monkeypatch.setattr(storage, "exists", checked_exists)
        monkeypatch.setattr(storage, "delete", checked_delete)
        result = await reconcile_orphan_objects(session)
        assert result["orphan_objects_deleted"] == 4
        assert original_exists("unrelated/keep.jpg")
        assert all(not original_exists(row.object_key) for row in intents)


async def test_expired_worker_cannot_commit_uploaded_resources(
    committed_asset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset, settings = committed_asset
    job = await owned_job(asset.id)
    storage = LocalStorage(tmp_path / "private")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    original_thread = asyncio.to_thread
    stolen = False
    async with SessionLocal() as session:
        current = await session.get(Asset, asset.id)

        async def steal_before_upload(function, *arguments, **keywords):
            nonlocal stolen
            assert not session.in_transaction()
            if getattr(function, "__self__", None) is storage and not stolen:
                stolen = True
                async with SessionLocal() as contender:
                    await contender.execute(
                        update(Job)
                        .where(Job.id == job.id)
                        .values(
                            worker_id="worker-b",
                            fence_token=job.fence_token + 1,
                            lease_until=utcnow() + timedelta(minutes=5),
                        )
                    )
                    await contender.commit()
            return await original_thread(function, *arguments, **keywords)

        monkeypatch.setattr(
            "photointel.services.media.asyncio.to_thread", steal_before_upload
        )
        with pytest.raises(LeaseLost):
            await process_asset(
                session,
                current,
                settings,
                job_fences=[(job.id, "worker-a", job.fence_token)],
            )
        await session.rollback()
    async with SessionLocal() as session:
        assert (
            await session.scalar(
                select(func.count())
                .select_from(AssetResource)
                .where(AssetResource.asset_id == asset.id)
            )
            == 0
        )
        assert not await heartbeat_many(
            session, [job.id], "worker-a", {job.id: job.fence_token}
        )
        owner = await session.get(Job, job.id)
        assert owner.worker_id == "worker-b"


async def test_durable_slot_claim_is_atomic_and_expired_owner_is_fenced() -> None:
    key = f"regression-slot:{uuid4()}"

    async def contender(owner: str):
        async with SessionLocal() as session:
            token = await acquire_lease(session, key, owner, 60)
            await session.commit()
            return owner, token

    results = await asyncio.gather(contender("first"), contender("second"))
    winners = [item for item in results if item[1] is not None]
    assert len(winners) == 1
    owner, token = winners[0]
    async with SessionLocal() as session:
        await session.execute(
            text(
                "UPDATE durable_leases SET lease_until=now()-interval "
                "'1 second' WHERE key=:key"
            ),
            {"key": key},
        )
        await session.commit()
        new_token = await acquire_lease(session, key, "new", 60)
        await session.commit()
        assert new_token > token
        with pytest.raises(LeaseLost):
            await assert_lease(session, key, owner, token)
        await session.rollback()
        await session.execute(
            text("DELETE FROM durable_leases WHERE key=:key"), {"key": key}
        )
        await session.commit()


async def test_real_inference_adapter_releases_sql_before_r2_and_gpu_and_fences_result(
    committed_asset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel.services import inference
    from photointel.storage import object_key

    asset, original_settings = committed_asset
    settings = original_settings.model_copy(
        update={
            "gpu_enabled": True,
            "inference_backend": "test",
            "batch_size": 1,
        }
    )
    job = await owned_job(asset.id)
    storage = LocalStorage(tmp_path / "private")
    image = original_settings.temp_directory / "fixtures" / "test.jpg"
    key = object_key(str(asset.id), asset.representation_revision, "preview_large")
    storage.put(key, image.read_bytes(), "image/jpeg")
    async with SessionLocal() as session:
        session.add(
            AssetResource(
                asset_id=asset.id,
                resource_type="preview_large",
                revision=asset.representation_revision,
                object_key=key,
                status="available",
                mime_type="image/jpeg",
                byte_size=image.stat().st_size,
            )
        )
        await session.commit()
        original_get = storage.get
        original_infer = inference.image_inference
        external_calls = []

        def checked_get(object_key: str) -> bytes:
            assert not session.in_transaction(), "R2 GET retained a SQL transaction"
            external_calls.append("r2")
            return original_get(object_key)

        async def interrupted_inference(request, configured):
            assert not session.in_transaction(), (
                "GPU inference retained a SQL transaction"
            )
            external_calls.append("gpu")
            response = await original_infer(request, configured)
            async with SessionLocal() as newer:
                await newer.execute(
                    update(Job)
                    .where(Job.id == job.id)
                    .values(
                        worker_id="new-gpu-owner",
                        fence_token=job.fence_token + 1,
                        lease_until=utcnow() + timedelta(minutes=5),
                    )
                )
                await newer.commit()
            return response

        monkeypatch.setattr(storage, "get", checked_get)
        monkeypatch.setattr(inference, "get_storage", lambda: storage)
        monkeypatch.setattr(inference, "image_inference", interrupted_inference)
        with pytest.raises(LeaseLost):
            await inference.infer_assets(
                session,
                [asset.id],
                settings,
                job_fences=[(job.id, "worker-a", job.fence_token)],
            )
        await session.rollback()
        assert external_calls == ["r2", "gpu"]
        assert (
            await session.scalar(
                text("SELECT count(*) FROM embeddings WHERE asset_id=:asset_id"),
                {"asset_id": asset.id},
            )
            == 0
        )


async def test_competing_workers_claim_one_job_only_and_increment_fence(committed_asset):
    asset, _ = committed_asset
    job = await owned_job(asset.id)
    async with SessionLocal() as session:
        await session.execute(
            update(Job)
            .where(Job.id == job.id)
            .values(
                status="queued",
                worker_id=None,
                lease_until=None,
            )
        )
        await session.commit()

    async def claim(owner):
        async with SessionLocal() as session:
            claimed = await claim_jobs(session, owner, 1)
            await session.commit()
            return [(row.id, row.fence_token) for row in claimed]

    claims = await asyncio.gather(claim("competing-a"), claim("competing-b"))
    relevant = [
        token for result in claims for identifier, token in result if identifier == job.id
    ]
    assert relevant == [job.fence_token + 1]


async def test_cloud_run_sigterm_leaves_claim_recoverable_without_success(
    committed_asset,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel.services import task_runner, worker
    from photointel.services.jobs import recover_stale_jobs

    asset, _ = committed_asset
    job = await owned_job(asset.id)
    async with SessionLocal() as session:
        await session.execute(
            update(Job)
            .where(Job.id == job.id)
            .values(
                status="queued",
                worker_id=None,
                lease_until=None,
            )
        )
        await session.commit()
    entered, stop = asyncio.Event(), asyncio.Event()

    async def slow_dispatch(session, claimed):
        await session.commit()
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(worker, "_dispatch", slow_dispatch)
    execution = asyncio.create_task(
        task_runner.run_finite(
            "worker",
            max_jobs=1,
            deadline_seconds=10,
            stopped=stop,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=5)
    stop.set()
    result = await asyncio.wait_for(execution, timeout=12)
    assert result["status"] == "interrupted"
    assert result["claimed_jobs"] == 1
    async with SessionLocal() as session:
        claimed = await session.get(Job, job.id)
        assert claimed.status == "running"
        claimed.lease_until = utcnow() - timedelta(seconds=1)
        await session.commit()
        assert await recover_stale_jobs(session) >= 1
        await session.commit()
        await session.refresh(claimed)
        assert claimed.status == "retrying"
        assert claimed.error_code == "WORKER_LEASE_EXPIRED"


async def test_equal_length_corrupt_ephemeral_cache_rehydrates_durable_source(
    committed_asset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hashlib

    asset, initial_settings = committed_asset
    settings = initial_settings.model_copy(
        update={
            "icloud_download_directory": tmp_path / "ephemeral-cache",
        }
    )
    original = (initial_settings.temp_directory / "fixtures" / "test.jpg").read_bytes()
    cached = settings.icloud_download_directory / "managed.image"
    cached.parent.mkdir(parents=True)
    corrupted = bytes([original[0] ^ 1]) + original[1:]
    assert len(corrupted) == len(original)
    cached.write_bytes(corrupted)
    storage = LocalStorage(tmp_path / "private")
    key = f"sources/{asset.id}/synthetic.image"
    storage.put(key, original, "image/jpeg")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    async with SessionLocal() as session:
        current = await session.get(Asset, asset.id)
        current.source_metadata = {"cache_relative_path": "managed.image"}
        session.add(
            AssetResource(
                asset_id=asset.id,
                resource_type="source_download",
                revision=asset.content_revision,
                object_key=key,
                byte_size=len(original),
                sha256=hashlib.sha256(original).hexdigest(),
                status="available",
            )
        )
        await session.commit()
        result = await process_asset(session, current, settings)
        await session.commit()
        assert result["variants"] == 4
        assert cached.read_bytes() == original
        assert (
            current.source_metadata["last_cache_incident"]["code"]
            == "LOCAL_SHA256_MISMATCH"
        )


async def test_retention_checks_preview_jobs_and_recovers_interrupted_delete(
    committed_asset,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hashlib

    from photointel.services.media import cleanup_temporary_media

    asset, initial = committed_asset
    settings = initial.model_copy(
        update={"icloud_download_directory": tmp_path / "cache"}
    )
    data = (initial.temp_directory / "fixtures" / "test.jpg").read_bytes()
    cached = settings.icloud_download_directory / "source.image"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(data)
    storage = LocalStorage(tmp_path / "private")
    source_key = f"sources/{asset.id}/retention.image"
    storage.put(source_key, data, "image/jpeg")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    async with SessionLocal() as session:
        current = await session.get(Asset, asset.id)
        current.source_metadata = {"cache_relative_path": "source.image"}
        source = AssetResource(
            asset_id=asset.id,
            resource_type="source_download",
            revision=asset.content_revision,
            object_key=source_key,
            byte_size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            status="available",
        )
        session.add(source)
        await session.commit()
        await process_asset(session, current, settings)
        current.classification_status = "not_configured"
        await session.commit()
        await session.execute(
            update(AssetResource)
            .where(
                AssetResource.asset_id == asset.id,
                AssetResource.resource_type.in_(("source_download", "inference_input")),
            )
            .values(created_at=utcnow() - timedelta(days=2))
        )
        await session.commit()
        job = await owned_job(asset.id)
        result = await cleanup_temporary_media(session, settings)
        assert result["temporary_objects_deleted"] == 0
        await session.execute(
            update(Job)
            .where(Job.id == job.id)
            .values(
                status="completed",
                lease_until=None,
            )
        )
        await session.commit()
        real_exists, real_delete = storage.exists, storage.delete
        preview = await session.scalar(
            select(AssetResource.object_key).where(
                AssetResource.asset_id == asset.id,
                AssetResource.resource_type == "preview_large",
            )
        )
        await session.commit()

        def missing_preview(key):
            assert not session.in_transaction()
            return False if key == preview else real_exists(key)

        monkeypatch.setattr(storage, "exists", missing_preview)
        result = await cleanup_temporary_media(session, settings)
        assert result["temporary_objects_deleted"] == 0
        assert real_exists(source_key)
        monkeypatch.setattr(storage, "exists", real_exists)

        def interrupted_delete(key):
            assert not session.in_transaction()
            raise OSError("storage interruption")

        monkeypatch.setattr(storage, "delete", interrupted_delete)
        result = await cleanup_temporary_media(session, settings)
        assert result["temporary_cleanup_failures"] == 2
        states = list(
            (
                await session.scalars(
                    select(AssetResource.status).where(
                        AssetResource.asset_id == asset.id,
                        AssetResource.resource_type.in_(
                            ("source_download", "inference_input")
                        ),
                    )
                )
            ).all()
        )
        assert states == ["retiring", "retiring"]
        await session.commit()

        def checked_delete(key):
            assert not session.in_transaction()
            real_delete(key)

        monkeypatch.setattr(storage, "delete", checked_delete)
        result = await cleanup_temporary_media(session, settings)
        assert result["temporary_objects_deleted"] == 2
        assert result["managed_download_caches_deleted"] == 1
        assert not real_exists(source_key)
        assert real_exists(preview)
        assert not cached.exists()
