"""Real PostgreSQL queue and fixture-media integration, isolated with a savepoint."""

from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from photointel.database import engine
from photointel.errors import AppError
from photointel.models import Asset, AssetResource, Job, JobBatch, utcnow
from photointel.services.fixtures import generate_fixtures
from photointel.services.ingestion import ingest_fixture_directory
from photointel.services.jobs import (
    claim_jobs,
    enqueue_job,
    heartbeat,
    recover_stale_jobs,
)
from photointel.storage import LocalStorage
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(
            bind=connection,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ) as database:
            yield database
        await transaction.rollback()


async def test_jobs_idempotency_leases_and_paused_batches(session: AsyncSession) -> None:
    prefix = str(uuid4())
    batch = JobBatch(name="paused", status="paused")
    session.add(batch)
    await session.flush()
    hidden = await enqueue_job(
        session,
        "icloud_discovery",
        payload={"source": "fixture"},
        idempotency_key=f"{prefix}:paused",
        batch_id=batch.id,
    )
    first = await enqueue_job(
        session,
        "icloud_discovery",
        idempotency_key=f"{prefix}:first",
        priority=9999,
    )
    again = await enqueue_job(
        session,
        "icloud_discovery",
        idempotency_key=f"{prefix}:first",
        priority=9999,
    )
    assert first.id == again.id
    claimed = await claim_jobs(session, f"test-worker-{prefix}", limit=32)
    assert first.id in {job.id for job in claimed}
    assert hidden.id not in {job.id for job in claimed}
    assert first.attempts == 1
    assert not await heartbeat(session, first.id, "different-worker")
    assert await heartbeat(session, first.id, f"test-worker-{prefix}")
    first.lease_until = utcnow() - timedelta(seconds=1)
    await session.flush()
    assert await recover_stale_jobs(session) >= 1
    assert first.status == "retrying"
    assert first.worker_id is None


async def test_fixture_import_has_durable_jobs_private_variants_and_no_duplicates(
    session: AsyncSession,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = tmp_path / "fixtures"
    generate_fixtures(directory, 2)
    storage = LocalStorage(tmp_path / "private-media")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    import photointel.services.ingestion as ingestion

    library_function = ingestion._library
    source_identifier = f"integration-fixture-{uuid4()}"

    async def test_library(
        database: AsyncSession,
        source: str,
        identifier: str,
        name: str,
    ):
        return await library_function(database, source, source_identifier, name)

    monkeypatch.setattr(ingestion, "_library", test_library)
    first = await ingest_fixture_directory(
        session,
        directory,
        limit=2,
        process_inline=True,
    )
    assert first["imported"] == 2
    second = await ingest_fixture_directory(
        session,
        directory,
        limit=2,
        process_inline=True,
    )
    assert second["imported"] == 0
    resources = list(
        (
            await session.scalars(
                select(AssetResource)
                .join(
                    Asset,
                    Asset.id == AssetResource.asset_id,
                )
                .where(Asset.library_id == UUID(first["library_id"]))
            )
        ).all()
    )
    assert len(resources) == 8
    assert all(
        row.status == "available" and storage.exists(row.object_key) for row in resources
    )
    count = await session.scalar(
        select(func.count())
        .select_from(Job)
        .where(
            Job.asset_id.in_(
                select(Asset.id).where(
                    Asset.library_id == UUID(first["library_id"]),
                )
            ),
            Job.job_type == "media_download",
        )
    )
    assert count == 2


async def test_changed_source_refreshes_metadata_and_fences_old_work(
    session: AsyncSession,
) -> None:
    from datetime import UTC, datetime

    from photointel.services.ingestion import _library, _upsert_asset

    library = await _library(session, "fixture", f"revision-{uuid4()}", "Revision test")
    first, _ = await _upsert_asset(
        session,
        library,
        source_key="asset",
        filename="before.jpg",
        revision="1",
        metadata={"fixture": True},
        size=100,
    )
    second, created = await _upsert_asset(
        session,
        library,
        source_key="asset",
        filename="after.jpg",
        revision="2",
        metadata={"fixture": True},
        size=200,
        captured_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    assert not created and first.id == second.id
    assert second.filesize == 200 and second.filename == "after.jpg"
    assert second.captured_at.year == 2020
    jobs = (await session.scalars(select(Job).where(Job.asset_id == first.id))).all()
    assert {job.payload["content_revision"] for job in jobs} == {"1", "2"}
    unavailable, _ = await _upsert_asset(
        session,
        library,
        source_key="missing-representation",
        filename="raw.dng",
        revision="1",
        metadata={"representation_unavailable": "medium_missing"},
        size=9999,
    )
    assert (
        await session.scalar(
            select(func.count())
            .select_from(Job)
            .where(
                Job.asset_id == unavailable.id,
            )
        )
        == 0
    )


async def test_preview_rebuild_preserves_source_identity_after_cache_retirement(
    session: AsyncSession,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel.config import Settings
    from photointel.services.media import source_path, verify_media_stage

    settings = Settings(temp_directory=tmp_path / "processing")

    async def configuration(database: AsyncSession) -> Settings:
        return settings

    monkeypatch.setattr("photointel.services.ingestion.effective_settings", configuration)
    storage = LocalStorage(tmp_path / "private")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    source = tmp_path / "fixture-art"
    generate_fixtures(source, 1)
    result = await ingest_fixture_directory(session, source, limit=1, process_inline=True)
    asset = await session.scalar(
        select(Asset)
        .where(
            Asset.library_id == UUID(result["library_id"]),
        )
        .limit(1)
    )
    assert asset is not None
    source_hash, revision = asset.sha256, asset.representation_revision
    small = await session.scalar(
        select(AssetResource).where(
            AssetResource.asset_id == asset.id,
            AssetResource.resource_type == "thumbnail_small",
        )
    )
    assert small is not None and small.object_key
    storage.delete(small.object_key)
    source_path(asset, settings).unlink()
    rebuilt = await verify_media_stage(
        session,
        asset,
        settings,
        "thumbnail_generate",
        force=True,
    )
    assert rebuilt["source"] == "retained_preview"
    # Re-encoding a retained preview may produce different bytes. The immutable
    # object key changes while the source identity and resource revision remain.
    await session.refresh(small)
    assert storage.exists(small.object_key)
    assert asset.sha256 == source_hash and asset.representation_revision == revision
    with pytest.raises(AppError, match="Cache retirado"):
        await verify_media_stage(session, asset, settings, "hash_generate", force=True)


async def test_exact_group_is_invalidated_when_representation_changes(
    session: AsyncSession,
) -> None:
    from photointel.models import DuplicateGroup, DuplicateMember
    from photointel.services.duplicates import (
        analyze_duplicates,
        invalidate_duplicate_memberships,
    )
    from photointel.services.ingestion import _library

    library = await _library(session, "fixture", f"edited-{uuid4()}", "Edited duplicate")
    assets = [
        Asset(
            library_id=library.id,
            source_asset_key=f"copy-{index}",
            filename="same.jpg",
            sha256="a" * 64,
            phash="0" * 16,
            width=100 + index,
            height=100,
            quality={"sharpness_laplacian_variance": 10},
            ingestion_status="completed",
        )
        for index in range(3)
    ]
    session.add_all(assets)
    await session.flush()
    result = await analyze_duplicates(session, assets[2])
    identifier = UUID(result["groups"][0])
    await invalidate_duplicate_memberships(session, assets[2].id)
    await session.flush()
    assert (
        await session.scalar(
            select(func.count())
            .select_from(DuplicateMember)
            .where(
                DuplicateMember.group_id == identifier,
            )
        )
        == 2
    )
    representative = await session.scalar(
        select(
            DuplicateGroup.representative_asset_id,
        ).where(DuplicateGroup.id == identifier)
    )
    assert representative != assets[2].id
    assert (
        await session.scalar(
            select(func.count())
            .select_from(Asset)
            .where(
                Asset.library_id == library.id,
            )
        )
        == 3
    )
