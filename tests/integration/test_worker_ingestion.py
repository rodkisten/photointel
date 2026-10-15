"""Real PostgreSQL queue and fixture-media integration, isolated with a savepoint."""

from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.database import engine
from photointel.models import Asset, AssetResource, Job, JobBatch, utcnow
from photointel.services.fixtures import generate_fixtures
from photointel.services.ingestion import ingest_fixture_directory
from photointel.services.jobs import (
    claim_jobs, enqueue_job, heartbeat, recover_stale_jobs,
)
from photointel.storage import LocalStorage

pytestmark = pytest.mark.integration


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    async with engine.connect() as connection:
        transaction = await connection.begin()
        async with AsyncSession(bind=connection, expire_on_commit=False,
                                join_transaction_mode="create_savepoint") as database:
            yield database
        await transaction.rollback()


async def test_jobs_idempotency_leases_and_paused_batches(session: AsyncSession) -> None:
    prefix = str(uuid4())
    batch = JobBatch(name="paused", status="paused")
    session.add(batch)
    await session.flush()
    hidden = await enqueue_job(session, "icloud_discovery", payload={"source": "fixture"},
                               idempotency_key=f"{prefix}:paused", batch_id=batch.id)
    first = await enqueue_job(
        session, "icloud_discovery", idempotency_key=f"{prefix}:first", priority=9999,
    )
    again = await enqueue_job(
        session, "icloud_discovery", idempotency_key=f"{prefix}:first", priority=9999,
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
    session: AsyncSession, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    directory = tmp_path / "fixtures"
    generate_fixtures(directory, 2)
    storage = LocalStorage(tmp_path / "private-media")
    monkeypatch.setattr("photointel.services.media.get_storage", lambda: storage)
    import photointel.services.ingestion as ingestion
    library_function = ingestion._library
    source_identifier = f"integration-fixture-{uuid4()}"

    async def test_library(
        database: AsyncSession, source: str, identifier: str, name: str,
    ):
        return await library_function(database, source, source_identifier, name)

    monkeypatch.setattr(ingestion, "_library", test_library)
    first = await ingest_fixture_directory(
        session, directory, limit=2, process_inline=True,
    )
    assert first["imported"] == 2
    second = await ingest_fixture_directory(
        session, directory, limit=2, process_inline=True,
    )
    assert second["imported"] == 0
    resources = list((await session.scalars(select(AssetResource).join(
        Asset, Asset.id == AssetResource.asset_id,
    ).where(Asset.library_id == UUID(first["library_id"])))).all())
    assert len(resources) == 8
    assert all(row.status == "available" and storage.exists(row.object_key)
               for row in resources)
    count = await session.scalar(select(func.count()).select_from(Job).where(
        Job.asset_id.in_(select(Asset.id).where(
            Asset.library_id == UUID(first["library_id"]),
        )),
        Job.job_type == "media_download",
    ))
    assert count == 2
