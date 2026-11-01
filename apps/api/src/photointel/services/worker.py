"""Crash-resumable workers with PostgreSQL leases and ownership-fenced commits."""

import asyncio
import contextlib
import os
import signal
import socket
import time
from contextvars import Token
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import structlog
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
)

from photointel.config import get_settings
from photointel.database import SessionLocal
from photointel.errors import AppError, ErrorCode
from photointel.models import Asset, DiscoveryManifest, Job, JobEvent, utcnow
from photointel.observability import correlation_context, valid_correlation
from photointel.sentry_observability import capture_exception, continue_job_trace
from photointel.services.job_notify import safe_notify
from photointel.services.jobs import (
    ACTIVE,
    claim_jobs,
    enqueue_job,
    heartbeat_many,
    refresh_batch,
    retry_delay,
    worker_seen,
)
from photointel.services.leases import (
    JobFence,
    LeaseLost,
    acquire_lease,
    assert_job_fences,
    release_lease,
    renew_lease,
)
from photointel.services.runtime_settings import effective_settings

logger = structlog.get_logger()


def _job_correlation(job: Job) -> str:
    """Old persisted jobs fall back to their own stable identifier."""
    return valid_correlation(job.payload.get("correlation_id")) or str(job.id)


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
    fences = (
        [(job.id, job.worker_id, job.fence_token)]
        if job.worker_id and job.status in ACTIVE
        else None
    )
    if job.job_type == "icloud_discovery":
        from photointel.services.ingestion import ingest_fixture_directory

        if job.payload.get("source") == "fixture":
            from photointel.services.fixtures import generate_fixtures

            directory = settings.temp_directory / "fixtures"
            await session.commit()
            await asyncio.to_thread(generate_fixtures, directory)
            return await ingest_fixture_directory(
                session,
                directory,
                int(job.payload.get("limit", settings.ingestion_import_limit)),
                batch_id=job.batch_id,
            )
        if job.payload.get("library_id"):
            from photointel.models import Library

            library = await session.get(Library, UUID(job.payload["library_id"]))
            if not library or library.source_type != "icloud":
                raise AppError(ErrorCode.INVALID_REQUEST, "Biblioteca iCloud inválida")
            settings = settings.model_copy(update={"icloud_library": library.name})
        from photointel.services.discovery import discover_icloud

        authorization = job.payload.get("authorization", {})
        limit = int(
            authorization.get(
                "requested_batch_limit",
                job.payload.get("limit", settings.ingestion_import_limit),
            )
        )
        await session.commit()
        return await discover_icloud(
            settings,
            execution_limit=limit,
            job_id=job.id,
            batch_id=job.batch_id,
            full_scan=bool(job.payload.get("full_scan", False)),
            mode=str(job.payload.get("mode", "incremental")),
            owner=job.worker_id,
            fence_token=job.fence_token,
        )
    if not job.asset_id:
        raise AppError(ErrorCode.INVALID_REQUEST, "Job exige asset_id")
    asset = await session.get(Asset, job.asset_id)
    if not asset:
        raise AppError(ErrorCode.NOT_FOUND, "Foto não encontrada", 404)
    revision = asset.content_revision
    reason = superseded_reason(job.payload, revision, asset.representation_revision)
    if reason:
        return {"skipped": True, "reason": reason}
    if job.job_type == "media_download":
        if not asset.source_metadata.get("fixture"):
            from photointel.services.discovery import download_discovered_asset

            await session.commit()
            await download_discovered_asset(
                asset.id,
                settings,
                job_id=job.id,
                owner=job.worker_id,
                fence_token=job.fence_token,
            )
            if fences:
                await assert_job_fences(session, fences)
            asset = await session.get(Asset, job.asset_id, populate_existing=True)
            assert asset is not None
            revision = asset.content_revision
        else:
            from photointel.services.media import source_path

            await session.commit()
            path = await asyncio.to_thread(source_path, asset, settings)
            size = await asyncio.to_thread(lambda: path.stat().st_size)
            if size > settings.max_download_bytes:
                raise AppError(
                    ErrorCode.MEDIA_DOWNLOAD_FAILED, "Representação excede o limite"
                )
            if fences:
                await assert_job_fences(session, fences)
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

        result = await process_asset(session, asset, settings, job_fences=fences)
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
            job_fences=fences,
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
            job_fences=fences,
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


def lease_sessions() -> async_sessionmaker[AsyncSession]:
    # External stages release their SQL connection, so the same bounded,
    # TLS/pooler-aware factory is sufficient for short heartbeat transactions.
    return SessionLocal


async def _heartbeat_many_loop(
    job_ids: list[UUID],
    worker_id: str,
    stopped: asyncio.Event,
    fence_tokens: dict[UUID, int] | None = None,
    asset_leases: list[tuple[str, int]] | None = None,
) -> None:
    while not stopped.is_set():
        try:
            async with lease_sessions()() as session:
                renewed = await heartbeat_many(session, job_ids, worker_id, fence_tokens)
                if renewed != len(job_ids):
                    stopped.set()
                    return
                for key, token in asset_leases or []:
                    if not await renew_lease(
                        session, key, worker_id, token, get_settings().job_lease_seconds
                    ):
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


async def _acquire_asset_leases(
    session: AsyncSession,
    jobs: list[Job],
    worker_id: str,
) -> list[tuple[str, int]]:
    leases = []
    for asset_id in sorted({job.asset_id for job in jobs if job.asset_id}, key=str):
        key = f"asset:{asset_id}"
        token = await acquire_lease(
            session, key, worker_id, get_settings().job_lease_seconds
        )
        if token is None:
            raise AssetBusy()
        leases.append((key, token))
    return leases


class AssetBusy(Exception):
    """Another committed job owns this asset; defer without consuming an attempt."""


def _is_session_lease_contention(exc: BaseException, job_type: str | None) -> bool:
    return (
        isinstance(exc, AppError)
        and exc.code == ErrorCode.RATE_LIMITED
        and job_type in {"media_download", "icloud_discovery"}
    )


def _is_retryable_transaction_conflict(exc: BaseException) -> bool:
    """PostgreSQL deadlocks and serialization conflicts must retry the entire job."""
    return isinstance(exc, DBAPIError) and getattr(exc.orig, "sqlstate", None) in {
        "40P01",  # deadlock_detected
        "40001",  # serialization_failure
    }


async def _fail_jobs(
    fences: list[JobFence],
    exc: BaseException,
    *,
    busy: bool = False,
    sentry_event_id: str | None = None,
) -> None:
    code = (
        exc.code
        if isinstance(exc, AppError)
        else "ASSET_BUSY"
        if busy
        else ErrorCode.INTERNAL_ERROR
    )
    async with SessionLocal() as session:
        changed: list[Job] = []
        for job_id, owner, token in fences:
            job = await session.scalar(
                select(Job)
                .where(
                    Job.id == job_id,
                    Job.worker_id == owner,
                    Job.fence_token == token,
                    Job.status.in_(ACTIVE),
                    Job.lease_until > utcnow(),
                )
                .with_for_update()
            )
            if job is None:
                continue
            changed.append(job)
            if busy:
                job.attempts = max(0, job.attempts - 1)
            job.status = "failed" if job.attempts >= job.maximum_attempts else "retrying"
            job.error_code = str(code)
            job.error_details = {
                "message": (
                    exc.message
                    if isinstance(exc, AppError)
                    else "Ativo ocupado; nova tentativa agendada"
                    if busy
                    else "Falha no processamento; verifique diagnóstico"
                ),
                "correlation_id": _job_correlation(job),
                "job_id": str(job.id),
                **({"sentry_event_id": sentry_event_id} if sentry_event_id else {}),
            }
            if sentry_event_id:
                recent = job.progress.get("sentry_attempt_events", [])
                if not isinstance(recent, list):
                    recent = []
                job.progress = {
                    **job.progress,
                    "sentry_attempt_events": [
                        *recent[-9:],
                        {"attempt": job.attempts, "event_id": sentry_event_id},
                    ],
                }
            job.scheduled_at = utcnow() + retry_delay(
                3 if busy else job.attempts, jitter=True
            )
            job.finished_at = utcnow() if job.status == "failed" else None
            job.lease_until = None

            if job.asset_id and not busy:
                asset = await session.get(Asset, job.asset_id, with_for_update=True)
                expected = job.payload.get("content_revision")
                if asset and (expected is None or expected == asset.content_revision):
                    asset.last_error = str(code)
                    if job.job_type in ("media_download", "metadata_extract"):
                        from photointel.services.discovery import failure_category

                        manifest = await session.scalar(
                            select(DiscoveryManifest)
                            .where(
                                DiscoveryManifest.asset_id == asset.id,
                                DiscoveryManifest.content_revision
                                == asset.content_revision,
                            )
                            .with_for_update()
                        )
                        if manifest and manifest.status != "completed":
                            category = failure_category(str(code))
                            permanent = category in {
                                "corrupt_media",
                                "invalid_representation",
                                "permanent_failure",
                            }
                            exhausted = (
                                job.status == "failed"
                                or manifest.attempts >= manifest.maximum_attempts
                            )
                            state = (
                                "quarantined" if permanent or exhausted else "retrying"
                            )
                            manifest.status = asset.ingestion_status = state
                            manifest.failure_category = category
                            manifest.last_error = str(code)[:64]
                            if state == "quarantined":
                                job.status = "failed"
                                job.finished_at = utcnow()
                        elif job.job_type == "media_download":
                            asset.ingestion_status = (
                                "quarantined" if job.status == "failed" else "retrying"
                            )
                    if job.job_type in ("joytag_inference", "embedding_inference"):
                        from photointel.services.inference import record_inference_failure

                        await record_inference_failure(
                            session,
                            asset.id,
                            await effective_settings(session),
                            str(code),
                        )
            session.add(
                JobEvent(
                    job_id=job.id,
                    status=job.status,
                    payload={
                        "error_code": str(code),
                        **(
                            {"sentry_event_id": sentry_event_id}
                            if sentry_event_id else {}
                        ),
                    }
                )
            )
        for batch_id in sorted(
            {job.batch_id for job in changed if job.batch_id}, key=str
        ):
            await refresh_batch(session, batch_id)
        await session.commit()
        for failed_job in changed:
            logger.warning(
                "worker_job_attempt_failed",
                job_id=str(failed_job.id),
                job_type=failed_job.job_type,
                status=failed_job.status,
                error_code=failed_job.error_code,
                correlation_id=_job_correlation(failed_job),
            )
    await safe_notify()


async def _finish_jobs(
    session: AsyncSession,
    jobs: list[Job],
    result: dict[str, Any],
    started: float,
    skipped: dict[UUID, str | None] | None = None,
) -> None:
    fences = [(job.id, str(job.worker_id), job.fence_token) for job in jobs]
    await assert_job_fences(session, fences)
    leader = jobs[0].id
    for job in jobs:
        reason = (skipped or {}).get(job.id)
        job.status, job.finished_at, job.lease_until = "completed", utcnow(), None
        job.error_code = job.error_details = None
        job.progress = (
            {"skipped": True, "reason": reason}
            if reason
            else {**result, "runtime_ms": round((time.monotonic() - started) * 1000, 2)}
            if job.id == leader
            else {"batch_metrics_job_id": str(leader)}
        )
        job.progress = {**job.progress,
            "correlation_id": _job_correlation(job)}
        session.add(
            JobEvent(
                job_id=job.id,
                status="completed",
                payload={
                    "runtime_ms": round((time.monotonic() - started) * 1000, 2),
                    "skipped": bool(reason),
                },
            )
        )
    await session.flush()
    for batch_id in sorted({job.batch_id for job in jobs if job.batch_id}, key=str):
        await refresh_batch(session, batch_id)
    await session.commit()
    for finished_job in jobs:
        logger.info(
            "worker_job_completed",
            job_id=str(finished_job.id),
            job_type=finished_job.job_type,
            correlation_id=_job_correlation(finished_job),
        )
    await safe_notify()


async def execute_job(job_id: UUID, worker_id: str) -> None:
    """Prepare/commit → external I/O → revision/fence checked short commit."""
    await _execute_claimed([job_id], worker_id, batch=False)


async def _execute_claimed(job_ids: list[UUID], worker_id: str, *, batch: bool) -> None:
    stopped = asyncio.Event()
    heartbeat_task: asyncio.Task[None] | None = None
    fences: list[JobFence] = []
    leases: list[tuple[str, int]] = []
    started = time.monotonic()
    correlation_token: Token[str | None] | None = None
    captured_payload: dict[str, Any] = {}
    captured_job_type: str | None = None
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
                        .order_by(Job.id)
                    )
                ).all()
            )
            if len(jobs) != len(job_ids):
                return
            captured_payload = dict(jobs[0].payload)
            captured_job_type = jobs[0].job_type
            correlation_token = correlation_context.set(
                _job_correlation(jobs[0])
            )
            for claimed_job in jobs:
                logger.info(
                    "worker_job_started",
                    job_id=str(claimed_job.id),
                    job_type=claimed_job.job_type,
                    correlation_id=_job_correlation(claimed_job),
                )
            fences = [(job.id, worker_id, job.fence_token) for job in jobs]
            leases = await _acquire_asset_leases(session, jobs, worker_id)
            await session.commit()
            heartbeat_task = asyncio.create_task(
                _heartbeat_many_loop(
                    job_ids,
                    worker_id,
                    stopped,
                    {job.id: job.fence_token for job in jobs},
                    leases,
                )
            )
            with continue_job_trace(jobs[0].payload):
                skipped: dict[UUID, str | None] = {}
                if batch:
                    from photointel.services.inference import infer_assets

                    assets = {
                        asset.id: asset
                        for asset in (
                            await session.scalars(
                                select(Asset).where(
                                    Asset.id.in_(
                                        [job.asset_id for job in jobs if job.asset_id]
                                    )
                                )
                            )
                        ).all()
                    }
                    if any(job.asset_id not in assets for job in jobs):
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
                    eligible = [job for job in jobs if not skipped.get(job.id)]
                    ids = sorted(
                        {job.asset_id for job in eligible if job.asset_id}, key=str
                    )
                    result = (
                        await infer_assets(
                            session,
                            ids,
                            await effective_settings(session),
                            job_fences=fences,
                            force_asset_ids={
                                job.asset_id
                                for job in eligible
                                if job.asset_id and job.payload.get("force")
                            },
                        )
                        if ids
                        else {"completed": 0, "skipped": len(jobs)}
                    )
                else:
                    result = await _dispatch(session, jobs[0])
                await _finish_jobs(session, jobs, result, started, skipped)
    except AssetBusy as exc:
        await _fail_jobs(fences, exc, busy=True)
    except (LeaseLost, asyncio.CancelledError):
        logger.info("worker_lease_released", jobs=len(job_ids))
        # SIGTERM/cancellation leaves the durable claim recoverable on expiry.
    except Exception as exc:
        if _is_session_lease_contention(exc, captured_job_type):
            # The encrypted iCloud session has a single owner by design.
            # Contention is scheduling, not a failed download or Sentry incident.
            await _fail_jobs(fences, exc, busy=True)
            logger.info(
                "worker_job_deferred", jobs=len(job_ids), reason="icloud_session_busy"
            )
            return
        if _is_retryable_transaction_conflict(exc):
            # A deadlock aborts this entire SQL transaction. Requeue the work
            # under its original fence instead of exhausting its attempt budget.
            await _fail_jobs(
                fences,
                AppError("DATABASE_CONTENTION", "Transação concorrente; tentativa reagendada", 503),
                busy=True,
            )
            logger.warning("worker_job_deferred", jobs=len(job_ids), reason="database_contention")
            return
        # Capture the *real traceback* before persisting a sanitized job failure.
        # Retried attempts retain separate event IDs in job.progress.
        with continue_job_trace(captured_payload):
            sentry_id = capture_exception(
                exc,
                correlation_id=correlation_context.get(),
                job_id=str(job_ids[0]) if job_ids else None,
                job_type=captured_job_type,
            )
        await _fail_jobs(fences, exc, sentry_event_id=sentry_id)
        logger.warning(
            "worker_job_failed", jobs=len(job_ids), exception_type=type(exc).__name__,
            correlation_id=correlation_context.get(),
        )
    finally:
        stopped.set()
        if heartbeat_task:
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
        for key, token in leases:
            with contextlib.suppress(Exception):
                async with SessionLocal() as session, session.begin():
                    await release_lease(session, key, worker_id, token)
        if correlation_token is not None:
            correlation_context.reset(correlation_token)


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
            if jobs or gpu_jobs:
                await safe_notify()
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
    """One real GPU batch; no connection or row lock remains held during inference."""
    await _execute_claimed(job_ids, worker_id, batch=True)


if __name__ == "__main__":
    asyncio.run(run_worker())
