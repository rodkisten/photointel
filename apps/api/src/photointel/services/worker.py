"""Crash-resumable workers with PostgreSQL leases and ownership-fenced commits."""

import asyncio
import contextlib
import os
import signal
import socket
import time
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from photointel.config import get_settings
from photointel.database import SessionLocal
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, IngestionRun, Job, JobEvent, utcnow
from photointel.services.jobs import (
    ACTIVE,
    claim_jobs,
    enqueue_job,
    heartbeat_many,
    refresh_batch,
    retry_delay,
    worker_seen,
)
from photointel.services.runtime_settings import effective_settings

logger = structlog.get_logger()


class LeaseLost(Exception):
    """The operation must roll back after cancellation, pause, or lease loss."""


def superseded_reason(
    payload: dict[str, Any],
    content_revision: str,
    representation_revision: str,
) -> str | None:
    expected = payload.get("content_revision")
    if expected is not None and expected != content_revision:
        return "superseded_content_revision"
    expected_input = payload.get("representation_revision")
    if expected_input is not None and expected_input != representation_revision:
        return "superseded_representation_revision"
    return None


async def _dispatch(session: AsyncSession, job: Job) -> dict[str, Any]:
    settings = await effective_settings(session)
    if job.job_type == "icloud_discovery":
        from photointel.services.ingestion import ingest_fixture_directory, ingest_icloud

        if job.payload.get("source") == "fixture":
            from photointel.services.fixtures import generate_fixtures

            directory = settings.temp_directory / "fixtures"
            await asyncio.to_thread(generate_fixtures, directory)
            return await ingest_fixture_directory(
                session,
                directory,
                min(int(job.payload.get("limit", 100)), settings.ingestion_import_limit),
                batch_id=job.batch_id,
            )
        if job.payload.get("library_id"):
            from photointel.models import Library

            library = await session.get(Library, UUID(job.payload["library_id"]))
            if not library or library.source_type != "icloud":
                raise AppError(ErrorCode.INVALID_REQUEST, "Biblioteca iCloud inválida")
            settings = settings.model_copy(update={"icloud_library": library.name})
        return await ingest_icloud(
            session,
            settings,
            limit=int(job.payload.get("limit", settings.ingestion_import_limit)),
            full_scan=bool(job.payload.get("full_scan", False)),
            job_id=job.id,
            batch_id=job.batch_id,
        )
    if not job.asset_id:
        raise AppError(ErrorCode.INVALID_REQUEST, "Job exige asset_id")
    # Serialize derived writes for an asset, without locking the heartbeat's job row.
    # Atomic, transaction-scoped advisory locks are released on process death.
    lock_key = int.from_bytes(job.asset_id.bytes[:8], "big", signed=True)
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
    asset = await session.get(Asset, job.asset_id)
    if not asset:
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    revision = asset.content_revision
    reason = superseded_reason(job.payload, revision, asset.representation_revision)
    if reason:
        return {"skipped": True, "reason": reason}
    if job.job_type == "media_download":
        from photointel.services.media import source_path

        if asset.media_type != "video":
            path = source_path(asset, settings)
            if path.stat().st_size > settings.max_download_bytes:
                raise AppError(
                    ErrorCode.MEDIA_DOWNLOAD_FAILED,
                    "Representação excede o limite",
                )
        await enqueue_job(
            session,
            "metadata_extract",
            asset.id,
            {"content_revision": revision},
            f"metadata_extract:{asset.id}:{revision}",
            job.batch_id,
        )
        return {"download_validated": True}
    if job.job_type == "metadata_extract":
        from photointel.services.media import process_asset

        result = await process_asset(session, asset, settings)
        for kind in ("thumbnail_generate", "hash_generate", "quality_analysis"):
            await enqueue_job(
                session,
                kind,
                asset.id,
                {"content_revision": revision},
                f"{kind}:{asset.id}:{revision}",
                job.batch_id,
            )
        if settings.gpu_enabled and asset.media_type == "image":
            for kind in ("joytag_inference", "embedding_inference"):
                await enqueue_job(
                    session,
                    kind,
                    asset.id,
                    {
                        "content_revision": revision,
                        "representation_revision": asset.representation_revision,
                    },
                    f"{kind}:{asset.id}:{asset.representation_revision}:"
                    f"{settings.joytag_model_revision}:{settings.siglip_model_revision}",
                    job.batch_id,
                )
        elif asset.media_type == "image":
            asset.classification_status = "not_configured"
        return result
    if job.job_type in ("thumbnail_generate", "hash_generate", "quality_analysis"):
        from photointel.services.media import verify_media_stage

        result = await verify_media_stage(
            session,
            asset,
            settings,
            job.job_type,
            force=bool(job.payload.get("force")),
        )
        if job.job_type == "hash_generate" and asset.media_type == "image":
            await enqueue_job(
                session,
                "duplicate_analysis",
                asset.id,
                {"content_revision": revision},
                f"duplicate_analysis:{asset.id}:{revision}",
                job.batch_id,
            )
        return result
    if job.job_type == "duplicate_analysis":
        from photointel.services.duplicates import analyze_duplicates

        return await analyze_duplicates(
            session,
            asset,
            int(job.payload.get("threshold", 6)),
        )
    if job.job_type in ("joytag_inference", "embedding_inference"):
        from photointel.services.inference import infer_assets

        return await infer_assets(
            session,
            [asset.id],
            settings,
            force=bool(job.payload.get("force")),
        )
    if job.job_type == "apple_sync":
        # Device work is retained in sync_operations. This worker cannot use PhotoKit.
        from photointel.models import SyncOperation

        operation_id = job.payload.get("operation_id")
        operation = (
            await session.get(SyncOperation, UUID(operation_id)) if operation_id else None
        )
        if not operation:
            raise AppError(ErrorCode.INVALID_REQUEST, "Operação Apple não encontrada")
        return {
            "operation_id": str(operation.id),
            "status": operation.status,
            "awaiting_device": True,
        }
    raise AppError(ErrorCode.INVALID_REQUEST, "Tipo de job desconhecido")


@lru_cache(maxsize=1)
def lease_sessions() -> async_sessionmaker[AsyncSession]:
    # Long-running media/GPU work can occupy every connection in the normal pool.
    # Short-lived lease connections must remain available independently. NullPool
    # also avoids retained connections when the CLI runs the worker for fixture seeding.
    lease_engine = create_async_engine(
        get_settings().database_url,
        poolclass=NullPool,
        pool_pre_ping=True,
    )
    return async_sessionmaker(lease_engine, expire_on_commit=False)


async def _heartbeat_many_loop(
    job_ids: list[UUID],
    worker_id: str,
    stopped: asyncio.Event,
) -> None:
    while not stopped.is_set():
        try:
            async with lease_sessions()() as session:
                renewed = await heartbeat_many(session, job_ids, worker_id)
                if renewed != len(job_ids):
                    stopped.set()
                    return
                await worker_seen(session, worker_id, job_ids[0] if job_ids else None)
                await session.commit()
        except Exception:
            # Never log credentials, SQL parameters, exception text, or image data.
            logger.warning("worker_heartbeat_unavailable", jobs=len(job_ids))
        Path("/tmp/photointel-worker.heartbeat").write_text(str(time.time()))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stopped.wait(), get_settings().job_heartbeat_seconds)


async def _heartbeat_loop(job_id: UUID, worker_id: str, stopped: asyncio.Event) -> None:
    await _heartbeat_many_loop([job_id], worker_id, stopped)


async def execute_job(job_id: UUID, worker_id: str) -> None:
    """Execute a committed claim, persisting output only while owning its lease."""
    stopped = asyncio.Event()
    heartbeat_task = asyncio.create_task(_heartbeat_loop(job_id, worker_id, stopped))
    started = time.monotonic()
    try:
        async with SessionLocal() as session:
            job = await session.get(Job, job_id)
            if (
                not job
                or job.worker_id != worker_id
                or job.status not in ACTIVE
                or not job.lease_until
                or job.lease_until <= utcnow()
            ):
                return
            batch_id = job.batch_id
            result = await _dispatch(session, job)
            # Flush results, then fence against concurrent cancellation/claim.
            await session.flush()
            fenced = (
                await session.execute(
                    update(Job)
                    .where(
                        Job.id == job_id,
                        Job.worker_id == worker_id,
                        Job.status.in_(ACTIVE),
                        Job.lease_until > utcnow(),
                    )
                    .values(
                        status="completed",
                        finished_at=utcnow(),
                        lease_until=None,
                        progress={
                            **result,
                            "runtime_ms": round(
                                (time.monotonic() - started) * 1000,
                                2,
                            ),
                        },
                        error_code=None,
                        error_details=None,
                    )
                    .returning(
                        Job.id,
                    )
                )
            ).scalar_one_or_none()
            if not fenced:
                raise LeaseLost()
            session.add(
                JobEvent(
                    job_id=job_id,
                    status="completed",
                    payload={
                        "runtime_ms": round((time.monotonic() - started) * 1000, 2),
                    },
                )
            )
            await refresh_batch(session, batch_id)
            await session.commit()
    except (LeaseLost, asyncio.CancelledError):
        # Rollback makes replay safe. Deterministic object keys may be overwritten.
        logger.info("worker_lease_released", job_id=str(job_id))
    except Exception as exc:
        code = exc.code if isinstance(exc, AppError) else ErrorCode.INTERNAL_ERROR
        message = (
            exc.message
            if isinstance(exc, AppError)
            else "Falha no processamento; verifique diagnóstico"
        )
        async with SessionLocal() as session:
            job = await session.scalar(
                select(Job)
                .where(
                    Job.id == job_id,
                    Job.worker_id == worker_id,
                    Job.status.in_(ACTIVE),
                    Job.lease_until > utcnow(),
                )
                .with_for_update()
            )
            if job:
                job.error_code = str(code)
                job.error_details = {"message": message}
                job.status = (
                    "failed" if job.attempts >= job.maximum_attempts else "retrying"
                )
                job.scheduled_at = utcnow() + retry_delay(job.attempts)
                job.finished_at = utcnow() if job.status == "failed" else None
                job.lease_until = None
                session.add(
                    JobEvent(
                        job_id=job_id,
                        status=job.status,
                        payload={"error_code": str(code)},
                    )
                )
                if job.asset_id:
                    asset = await session.get(Asset, job.asset_id)
                    if asset:
                        asset.last_error = str(code)
                        if job.job_type in ("joytag_inference", "embedding_inference"):
                            settings = await effective_settings(session)
                            if settings.gpu_enabled:
                                from photointel.services.inference import (
                                    record_inference_failure,
                                )

                                await record_inference_failure(
                                    session,
                                    asset.id,
                                    settings,
                                    str(code),
                                )
                if job.job_type == "icloud_discovery":
                    session.add(
                        IngestionRun(
                            job_id=job.id,
                            status="failed",
                            finished_at=utcnow(),
                            failed=1,
                            error=str(code),
                        )
                    )
                await refresh_batch(session, job.batch_id)
                await session.commit()
        logger.warning(
            "worker_job_failed",
            job_id=str(job_id),
            error_code=str(code),
            exception_type=type(exc).__name__,
        )
    finally:
        stopped.set()
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat_task


async def run_worker() -> None:
    settings = get_settings()
    worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:8]}"
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, shutdown.set)
    active: set[asyncio.Task[None]] = set()
    gpu_task: asyncio.Task[None] | None = None
    gpu_types = ("joytag_inference", "embedding_inference")
    while not shutdown.is_set():
        Path("/tmp/photointel-worker.heartbeat").write_text(str(time.time()))
        try:
            active = {task for task in active if not task.done()}
            async with SessionLocal() as session:
                settings = await effective_settings(session)
                capacity = settings.worker_concurrency - len(active)
                jobs = (
                    await claim_jobs(
                        session,
                        worker_id,
                        capacity,
                        exclude_types=gpu_types,
                    )
                    if capacity > 0
                    else []
                )
                gpu_jobs = (
                    await claim_jobs(
                        session,
                        worker_id,
                        min(settings.batch_size, 32),
                        job_types=gpu_types,
                    )
                    if gpu_task is None or gpu_task.done()
                    else []
                )
                current = jobs[0].id if jobs else gpu_jobs[0].id if gpu_jobs else None
                await worker_seen(
                    session,
                    worker_id,
                    current,
                    busy=bool(active or (gpu_task and not gpu_task.done())),
                )
                await session.commit()
            for job in jobs:
                active.add(asyncio.create_task(execute_job(job.id, worker_id)))
            if gpu_jobs:
                gpu_task = asyncio.create_task(
                    execute_inference_batch(
                        [job.id for job in gpu_jobs],
                        worker_id,
                    )
                )
        except Exception as exc:
            logger.warning("worker_poll_failed", exception_type=type(exc).__name__)
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(shutdown.wait(), settings.job_poll_seconds)
    # A bounded graceful shutdown lets ongoing commits finish; remaining leases recover.
    if gpu_task and not gpu_task.done():
        active.add(gpu_task)
    if active:
        _, pending = await asyncio.wait(active, timeout=25)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


async def execute_inference_batch(job_ids: list[UUID], worker_id: str) -> None:
    """Run many durable GPU jobs in one actual model batch, fenced as one transaction."""
    from photointel.services.inference import infer_assets

    stopped = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat_many_loop(job_ids, worker_id, stopped),
    )
    started = time.monotonic()
    try:
        async with SessionLocal() as session:
            jobs = list(
                (
                    await session.scalars(
                        select(Job)
                        .where(
                            Job.id.in_(job_ids),
                            Job.worker_id == worker_id,
                            Job.status.in_(ACTIVE),
                            Job.lease_until > utcnow(),
                        )
                        .order_by(Job.asset_id)
                    )
                ).all()
            )
            if len(jobs) != len(job_ids):
                raise LeaseLost()
            if any(job.asset_id is None for job in jobs):
                raise AppError(ErrorCode.INVALID_REQUEST, "Inferência exige asset_id")
            asset_ids = sorted({job.asset_id for job in jobs if job.asset_id}, key=str)
            for asset_id in asset_ids:
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(:key)"),
                    {
                        "key": int.from_bytes(asset_id.bytes[:8], "big", signed=True),
                    },
                )
            assets = {
                asset.id: asset
                for asset in (
                    await session.scalars(
                        select(Asset).where(Asset.id.in_(asset_ids)),
                    )
                ).all()
            }
            if len(assets) != len(asset_ids):
                raise AppError(ErrorCode.NOT_FOUND, "Ativo não encontrado", 404)
            skipped = {
                job.id: superseded_reason(
                    job.payload,
                    assets[job.asset_id].content_revision,
                    assets[job.asset_id].representation_revision,
                )
                for job in jobs
                if job.asset_id
            }
            eligible = [job for job in jobs if job.asset_id and not skipped.get(job.id)]
            eligible_ids = sorted(
                {job.asset_id for job in eligible if job.asset_id},
                key=str,
            )
            result = (
                await infer_assets(
                    session,
                    eligible_ids,
                    await effective_settings(session),
                    force_asset_ids={
                        job.asset_id
                        for job in eligible
                        if job.asset_id and job.payload.get("force")
                    },
                )
                if eligible_ids
                else {"completed": 0, "skipped": len(jobs)}
            )
            await session.flush()
            fenced = (
                await session.execute(
                    update(Job)
                    .where(
                        Job.id.in_(job_ids),
                        Job.worker_id == worker_id,
                        Job.status.in_(ACTIVE),
                        Job.lease_until > utcnow(),
                    )
                    .values(status="completed", lease_until=None, finished_at=utcnow())
                    .returning(Job.id)
                )
            ).all()
            if len(fenced) != len(jobs):
                raise LeaseLost()
            leader_id = eligible[0].id if eligible else None
            for job in jobs:
                if skipped.get(job.id):
                    job.progress = {"skipped": True, "reason": skipped[job.id]}
                elif job.id == leader_id:
                    job.progress = {
                        **result,
                        "batch_assets": len(eligible_ids),
                        "runtime_ms": round((time.monotonic() - started) * 1000, 2),
                    }
                else:
                    job.progress = {
                        "batch_metrics_job_id": str(leader_id),
                        "batch_assets": len(eligible_ids),
                    }
                session.add(
                    JobEvent(
                        job_id=job.id,
                        status="completed",
                        payload={
                            "batch_assets": len(eligible_ids),
                            "skipped": bool(skipped.get(job.id)),
                        },
                    )
                )
            for batch_id in sorted({job.batch_id for job in jobs}, key=str):
                await refresh_batch(session, batch_id)
            await session.commit()
    except (LeaseLost, asyncio.CancelledError):
        logger.info("worker_batch_lease_released", jobs=len(job_ids))
    except Exception as exc:
        code = exc.code if isinstance(exc, AppError) else str(ErrorCode.INFERENCE_FAILED)
        async with SessionLocal() as session:
            jobs = list(
                (
                    await session.scalars(
                        select(Job)
                        .where(
                            Job.id.in_(job_ids),
                            Job.worker_id == worker_id,
                            Job.status.in_(ACTIVE),
                            Job.lease_until > utcnow(),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            for job in jobs:
                job.status = (
                    "failed" if job.attempts >= job.maximum_attempts else "retrying"
                )
                job.error_code = code
                job.error_details = {
                    "message": (
                        "Inferência indisponível; verifique configuração ou orçamento"
                    ),
                }
                job.scheduled_at = utcnow() + retry_delay(job.attempts)
                job.finished_at = utcnow() if job.status == "failed" else None
                job.lease_until = None
                session.add(
                    JobEvent(
                        job_id=job.id, status=job.status, payload={"error_code": code}
                    )
                )
            settings = await effective_settings(session)
            if settings.gpu_enabled:
                from photointel.services.inference import record_inference_failure

                for asset_id in {job.asset_id for job in jobs if job.asset_id}:
                    await record_inference_failure(session, asset_id, settings, str(code))
            for batch_id in sorted({job.batch_id for job in jobs}, key=str):
                await refresh_batch(session, batch_id)
            await session.commit()
        logger.warning(
            "worker_gpu_batch_failed",
            jobs=len(job_ids),
            error_code=code,
            exception_type=type(exc).__name__,
        )
    finally:
        stopped.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(run_worker())
