"""Durable PostgreSQL jobs: transactional claim, leases, fences, and replay events."""

from datetime import timedelta
from random import uniform
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import exists, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import get_settings
from photointel.models import IngestionRun, Job, JobBatch, JobEvent, Setting, WorkerState, utcnow
from photointel.observability import job_correlation
from photointel.sentry_observability import trace_headers

JOB_TYPES = frozenset(
    {
        "icloud_discovery",
        "media_download",
        "metadata_extract",
        "thumbnail_generate",
        "hash_generate",
        "joytag_inference",
        "embedding_inference",
        "duplicate_analysis",
        "quality_analysis",
        "apple_sync",
    }
)
ACTIVE = ("preparing", "running")
TERMINAL = ("completed", "failed", "cancelled")


async def enqueue_job(
    session: AsyncSession,
    job_type: str,
    asset_id: UUID | None = None,
    payload: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    batch_id: UUID | None = None,
    *,
    priority: int = 0,
) -> Job:
    if job_type not in JOB_TYPES:
        raise ValueError("Unsupported job type")
    key = idempotency_key or f"manual:{job_type}:{uuid4()}"
    safe_payload = dict(payload or {})
    safe_payload["correlation_id"] = job_correlation(safe_payload)
    for name, value in trace_headers().items():
        safe_payload.setdefault(name, value)
    statement = (
        insert(Job)
        .values(
            id=uuid4(),
            job_type=job_type,
            asset_id=asset_id,
            payload=safe_payload,
            idempotency_key=key,
            batch_id=batch_id,
            priority=priority,
        )
        .on_conflict_do_nothing(index_elements=[Job.idempotency_key])
        .returning(Job.id)
    )
    created = (await session.execute(statement)).scalar_one_or_none()
    job = await session.scalar(select(Job).where(Job.idempotency_key == key))
    assert job is not None
    if created:
        session.add(
            JobEvent(
                job_id=job.id,
                status="queued",
                payload={"job_type": job_type},
            )
        )
    return job


def retry_delay(attempts: int, *, jitter: bool = False) -> timedelta:
    seconds = min(3600, 5 * 2 ** min(max(0, attempts - 1), 10))
    return timedelta(seconds=seconds * uniform(0.75, 1.0) if jitter else seconds)


async def recover_stale_jobs(session: AsyncSession, limit: int = 100) -> int:
    rows = (
        await session.scalars(
            select(Job)
            .where(
                Job.status.in_(ACTIVE),
                Job.lease_until < utcnow(),
            )
            .order_by(Job.lease_until)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    ).all()
    for job in rows:
        job.status = "failed" if job.attempts >= job.maximum_attempts else "retrying"
        job.scheduled_at = utcnow() + retry_delay(job.attempts)
        job.error_code = "WORKER_LEASE_EXPIRED"
        job.error_details = {
            "message": "Worker desconectou; lease recuperado com segurança",
        }
        job.lease_until = None
        job.worker_id = None
        if job.status == "failed":
            job.finished_at = utcnow()
        session.add(
            JobEvent(
                job_id=job.id, status=job.status, payload={"error_code": job.error_code}
            )
        )
    for batch_id in sorted({job.batch_id for job in rows if job.batch_id}, key=str):
        await refresh_batch(session, batch_id)
    await recover_interrupted_ingestion_runs(session, limit=limit)
    return len(rows)


async def recover_interrupted_ingestion_runs(
    session: AsyncSession, limit: int = 100
) -> int:
    """Close bounded abandoned attempts without changing a newer shared scan.

    A new claim resets Job.started_at, so an earlier run of that same job can be
    distinguished from its current attempt. Rows with no owning job are excluded:
    a standalone interactive import has no job lease to evaluate.
    """
    now = utcnow()
    runs = list(
        (
            await session.scalars(
                select(IngestionRun)
                .join(Job, Job.id == IngestionRun.job_id)
                .where(
                    IngestionRun.status == "running",
                    or_(
                        Job.status.not_in(ACTIVE),
                        Job.lease_until.is_(None),
                        Job.lease_until <= now,
                        IngestionRun.started_at < Job.started_at,
                    ),
                )
                .order_by(IngestionRun.started_at, IngestionRun.id)
                .limit(min(1000, max(1, limit)))
                .with_for_update(of=IngestionRun, skip_locked=True)
                .execution_options(populate_existing=True)
            )
        ).all()
    )
    for run in runs:
        run.status, run.finished_at = "failed", now
        run.error = "WORKER_INTERRUPTED"
    return len(runs)


async def claim_jobs(
    session: AsyncSession,
    worker_id: str,
    limit: int = 1,
    *,
    job_types: tuple[str, ...] | None = None,
    exclude_types: tuple[str, ...] = (),
    payload_mode: str | None = None,
) -> list[Job]:
    await recover_stale_jobs(session)
    # One durable switch controls all workers, including finite Cloud Run Jobs.
    # A paused queue may still receive new, durably staged jobs; none are claimed.
    queue_state = await session.get(Setting, "jobs_paused")
    if queue_state and queue_state.value:
        return []
    paused_batch = exists(
        select(JobBatch.id).where(
            JobBatch.id == Job.batch_id,
            JobBatch.status.in_(("paused", "cancelled")),
        )
    )
    filters = [
        Job.status.in_(("queued", "retrying")),
        Job.scheduled_at <= utcnow(),
        Job.attempts < Job.maximum_attempts,
        ~paused_batch,
    ]
    if payload_mode is not None:
        from sqlalchemy import func

        filters.append(
            func.coalesce(Job.payload["mode"].as_string(), "incremental") == payload_mode
        )
    if job_types:
        filters.append(Job.job_type.in_(job_types))
    if exclude_types:
        filters.append(Job.job_type.not_in(exclude_types))
    rows = (
        await session.scalars(
            select(Job)
            .where(
                *filters,
            )
            .order_by(Job.priority.desc(), Job.created_at, Job.id)
            .limit(min(32, max(1, limit)))
            .with_for_update(skip_locked=True)
        )
    ).all()
    for job in rows:
        job.status = "running"
        job.worker_id = worker_id
        job.attempts += 1
        job.fence_token += 1
        job.started_at = utcnow()
        job.heartbeat_at = utcnow()
        job.lease_until = utcnow() + timedelta(seconds=get_settings().job_lease_seconds)
        job.error_code = None
        job.error_details = None
        session.add(
            JobEvent(job_id=job.id, status="running", payload={"attempts": job.attempts})
        )
    return list(rows)


async def heartbeat_many(
    session: AsyncSession,
    job_ids: list[UUID],
    worker_id: str,
    fence_tokens: dict[UUID, int] | None = None,
) -> int:
    if fence_tokens is not None:
        renewed = 0
        for job_id in job_ids:
            token = fence_tokens.get(job_id)
            if token is None:
                continue
            row = await session.scalar(
                update(Job)
                .where(
                    Job.id == job_id,
                    Job.worker_id == worker_id,
                    Job.fence_token == token,
                    Job.status.in_(ACTIVE),
                    Job.lease_until > utcnow(),
                )
                .values(
                    heartbeat_at=utcnow(),
                    lease_until=utcnow()
                    + timedelta(seconds=get_settings().job_lease_seconds),
                )
                .returning(Job.id)
            )
            renewed += int(row is not None)
        return renewed
    if not job_ids:
        return 0
    result = await session.execute(
        update(Job)
        .where(
            Job.id.in_(job_ids),
            Job.worker_id == worker_id,
            Job.status.in_(ACTIVE),
            Job.lease_until > utcnow(),
        )
        .values(
            heartbeat_at=utcnow(),
            lease_until=utcnow()
            + timedelta(
                seconds=get_settings().job_lease_seconds,
            ),
        )
        .returning(Job.id)
    )
    return len(result.all())


async def heartbeat(
    session: AsyncSession,
    job_id: UUID,
    worker_id: str,
) -> bool:
    return await heartbeat_many(session, [job_id], worker_id) == 1


async def worker_seen(
    session: AsyncSession,
    worker_id: str,
    job_id: UUID | None = None,
    *,
    busy: bool = False,
) -> None:
    status = "running" if job_id or busy else "idle"
    await session.execute(
        insert(WorkerState)
        .values(
            id=worker_id,
            last_seen=utcnow(),
            current_job_id=job_id,
            status=status,
            capabilities=sorted(JOB_TYPES),
        )
        .on_conflict_do_update(
            index_elements=[WorkerState.id],
            set_={
                "last_seen": utcnow(),
                "current_job_id": job_id,
                "status": status,
            },
        )
    )


def _batch_lock_statement(batch_id: UUID):
    return (
        select(JobBatch)
        .where(JobBatch.id == batch_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )


async def refresh_batch(session: AsyncSession, batch_id: UUID | None) -> None:
    if not batch_id:
        return
    from sqlalchemy import func

    # Serialize aggregation after the job's fenced update. A stale concurrent
    # snapshot must not leave a fully completed batch marked as running forever.
    # FOR NO KEY UPDATE serializes batch writers without blocking FK KEY SHARE
    # checks from concurrently enqueued/updated jobs in the same batch.
    batch = await session.scalar(_batch_lock_statement(batch_id))
    if not batch:
        return
    counts: dict[str, int] = {
        status: count
        for status, count in (
            await session.execute(
                select(Job.status, func.count())
                .where(
                    Job.batch_id == batch_id,
                )
                .group_by(Job.status),
            )
        ).all()
    }
    # Asset counters stay meaningful even when one asset has many pipeline jobs.
    per_asset = (
        select(
            Job.asset_id,
            func.count().filter(Job.status.not_in(TERMINAL)).label("pending"),
            func.count().filter(Job.status == "failed").label("failed"),
            func.count().filter(Job.status == "cancelled").label("cancelled"),
            func.count().label("job_count"),
            func.count()
            .filter(Job.progress["skipped"].as_boolean().is_(True))
            .label("skipped_jobs"),
        )
        .where(Job.batch_id == batch_id, Job.asset_id.is_not(None))
        .group_by(
            Job.asset_id,
        )
        .subquery()
    )
    aggregate = (
        await session.execute(
            select(
                func.count().label("total"),
                func.count()
                .filter(
                    (per_asset.c.pending == 0)
                    & (per_asset.c.failed == 0)
                    & (per_asset.c.cancelled == 0)
                    & (per_asset.c.skipped_jobs < per_asset.c.job_count)
                )
                .label("completed"),
                func.count().filter(per_asset.c.failed > 0).label("failed"),
                func.count()
                .filter(
                    (
                        (per_asset.c.cancelled > 0)
                        | (per_asset.c.skipped_jobs == per_asset.c.job_count)
                    )
                    & (per_asset.c.failed == 0)
                    & (per_asset.c.pending == 0)
                )
                .label("skipped"),
            ).select_from(per_asset)
        )
    ).one()
    batch.total_assets = max(batch.total_assets, aggregate.total)
    batch.completed, batch.failed, batch.skipped = (
        aggregate.completed,
        aggregate.failed,
        aggregate.skipped,
    )
    batch.counters = {**batch.counters, "jobs_by_status": counts}
    if batch.status not in ("paused", "cancelled"):
        pending = sum(
            counts.get(state, 0)
            for state in (
                "queued",
                "retrying",
                "running",
                "preparing",
                "paused",
            )
        )
        batch.status = "running" if pending else "failed" if batch.failed else "completed"
