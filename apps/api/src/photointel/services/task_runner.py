"""Finite Cloud Run Job entry points; PostgreSQL is the only work queue.

The API never starts this runner in-process. Concurrent Cloud Run tasks claim work
atomically, so task indices need no offset partitioning and retries are idempotent.
"""

import argparse
import asyncio
import contextlib
import json
import os
import signal
import socket
import time
from typing import Any
from uuid import uuid4

MODES = ("discover", "backfill", "worker", "maintenance", "migrate")
GPU_TYPES = ("joytag_inference", "embedding_inference")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("mode", choices=MODES)
    result.add_argument("--max-jobs", type=int, default=100)
    result.add_argument("--deadline-seconds", type=int, default=540)
    return result


def validate_bounds(max_jobs: int, deadline_seconds: int) -> None:
    if not 1 <= max_jobs <= 10000:
        raise ValueError("max-jobs must be between 1 and 10000")
    if not 10 <= deadline_seconds <= 86400:
        raise ValueError("deadline-seconds must be between 10 and 86400")


async def dispatch_ready_worker_followup(
    mode: str, remaining_seconds: float
) -> dict[str, Any]:
    """Wake downstream processing after discovery, even with no Scheduler.

    Discover/backfill Jobs enqueue media_download and related work in PostgreSQL.
    This non-GPU wakeup is necessary because the discovery runner only claims
    icloud_discovery, while the normal worker handles derivative jobs.
    """
    if mode not in ("discover", "backfill", "worker", "maintenance"):
        return {"status": "not_applicable"}
    from sqlalchemy import select

    from photointel.config import get_settings
    from photointel.database import SessionLocal
    from photointel.models import Job, Setting, utcnow
    from photointel.services.outbox import drain_outbox, enqueue_dispatch

    if get_settings().execution_platform != "cloud_run":
        return {"status": "not_cloud_run"}
    async with SessionLocal() as session:
        state = await session.get(Setting, "jobs_paused")
        if state and state.value:
            return {"status": "queue_paused"}
        pending = await session.scalar(
            select(Job.id)
            .where(
                Job.status.in_(("queued", "retrying")),
                Job.job_type != "icloud_discovery",
                Job.scheduled_at <= utcnow(),
            )
            .order_by(Job.priority.desc(), Job.scheduled_at, Job.created_at)
            .limit(1)
        )
        if pending is not None:
            # Maintenance runs periodically even when a prior provider call
            # said "dispatched" but no worker managed to claim the queue.
            # One wakeup per ten-minute slot bounds redundant Cloud Run starts.
            dedupe_key = (
                f"maintenance-worker-wakeup:{int(time.time()) // 600}"
                if mode == "maintenance"
                else f"finite-worker-wakeup:{uuid4().hex}"
            )
            await enqueue_dispatch(session, "worker", dedupe_key)
        await session.commit()
    if pending is None:
        return {"status": "no_runnable_worker_jobs"}
    # Even near the deadline the intent stays durable in PostgreSQL. Never
    # run GCP calls while a database transaction is open.
    if remaining_seconds <= 1:
        return {"status": "queued_for_retry"}
    result = await drain_outbox(
        limit=3, deadline_seconds=min(20.0, remaining_seconds - 1)
    )
    return {"status": "wake_attempted", **result}


async def run_finite(
    mode: str,
    *,
    max_jobs: int = 100,
    deadline_seconds: int = 540,
    stopped: asyncio.Event | None = None,
) -> dict[str, Any]:
    validate_bounds(max_jobs, deadline_seconds)
    if mode not in MODES:
        raise ValueError("Unknown finite task mode")
    if mode == "migrate":
        # Alembic owns a separate direct connection and serializes migrations.
        # Neither the API nor ordinary task cold starts execute migrations.
        from alembic import command
        from alembic.config import Config

        await asyncio.to_thread(
            command.upgrade, Config("infra/migrations/alembic.ini"), "head"
        )
        return {"mode": mode, "status": "completed"}
    from photointel.config import get_settings
    from photointel.database import SessionLocal
    from photointel.services.jobs import claim_jobs, recover_stale_jobs, worker_seen
    from photointel.services.worker import execute_inference_batch, execute_job

    shutdown = stopped or asyncio.Event()
    started = time.monotonic()
    deadline = started + deadline_seconds
    worker_id = f"task:{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:12]}"
    from photointel.services.job_notify import safe_notify
    from photointel.services.outbox import drain_outbox

    await safe_notify()
    dispatches = await drain_outbox(
        limit=min(max_jobs, 10),
        deadline_seconds=min(30, max(1, deadline - time.monotonic())),
        stopped=shutdown,
    )
    preview_repair = {"status": "not_run"}
    if mode in ("worker", "maintenance"):
        from photointel.services.preview_repair import run_automatic_preview_repair

        try:
            preview_repair = await run_automatic_preview_repair()
        except Exception as exc:
            # A failed audit must never prevent queued photos from processing.
            import structlog

            from photointel.sentry_observability import capture_exception

            structlog.get_logger().exception("automatic_preview_sweep_failed")
            capture_exception(exc, error_code="AUTO_PREVIEW_SWEEP_FAILED")
            preview_repair = {"status": "failed"}
    if mode == "maintenance":
        from photointel.services.media import (
            cleanup_temporary_media,
            reconcile_orphan_objects,
        )

        async with SessionLocal() as session:
            recovered = await recover_stale_jobs(session, limit=min(max_jobs, 1000))
            await worker_seen(session, worker_id)
            await session.commit()
            if shutdown.is_set():
                return {"mode": mode, "status": "interrupted", "recovered": recovered}
            cleanup = await cleanup_temporary_media(
                session, get_settings(), limit=min(max_jobs, 1000)
            )
            orphans = await reconcile_orphan_objects(session, limit=min(max_jobs, 1000))
            await session.commit()
        followup = await dispatch_ready_worker_followup(
            mode, max(0.0, deadline - time.monotonic())
        )
        return {
            "mode": mode,
            "status": "completed",
            "recovered": recovered,
            "dispatches": dispatches,
            "followup": followup,
            "preview_repair": preview_repair,
            **cleanup,
            **orphans,
        }
    if mode == "discover":
        from photointel.services.ingestion import schedule_due_ingestion

        async with SessionLocal() as session:
            await schedule_due_ingestion(session)
            await session.commit()
    # Backfill executes only work already authorized and durably queued by API.
    # There is deliberately no flag capable of creating an unrestricted import.
    claimed_count = 0
    active: set[asyncio.Task[None]] = set()
    while not shutdown.is_set() and time.monotonic() < deadline:
        active = {task for task in active if not task.done()}
        capacity = min(
            get_settings().worker_concurrency - len(active), max_jobs - claimed_count
        )
        claimed = []
        if capacity > 0:
            async with SessionLocal() as session:
                claimed = await claim_jobs(
                    session,
                    worker_id,
                    capacity,
                    job_types=("icloud_discovery",)
                    if mode in ("discover", "backfill")
                    else None,
                    exclude_types=()
                    if mode in ("discover", "backfill")
                    else ("icloud_discovery",),
                    payload_mode="backfill"
                    if mode == "backfill"
                    else "incremental"
                    if mode == "discover"
                    else None,
                )
                await worker_seen(
                    session,
                    worker_id,
                    claimed[0].id if claimed else None,
                    busy=bool(active),
                )
                await session.commit()
            if claimed:
                await safe_notify()
            claimed_count += len(claimed)
            gpu_ids = [job.id for job in claimed if job.job_type in GPU_TYPES]
            for job in claimed:
                if job.job_type not in GPU_TYPES:
                    active.add(asyncio.create_task(execute_job(job.id, worker_id)))
            if gpu_ids:
                active.add(
                    asyncio.create_task(execute_inference_batch(gpu_ids, worker_id))
                )
        if not active:
            break
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(
                shutdown.wait(),
                min(
                    get_settings().job_poll_seconds,
                    max(0.01, deadline - time.monotonic()),
                ),
            )
    # Cloud Run sends SIGTERM before killing the task. Allow a short final commit;
    # cancelled operations leave claims and outbox entries durably recoverable.
    if active:
        grace = min(8.0, max(0.0, deadline - time.monotonic()))
        _, pending = await asyncio.wait(active, timeout=grace)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    followup = await dispatch_ready_worker_followup(
        mode, max(0.0, deadline - time.monotonic())
    )
    return {
        "mode": mode,
        "status": "interrupted" if shutdown.is_set() else "completed",
        "followup": followup,
        "claimed_jobs": claimed_count,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "source_of_truth": "postgresql",
        "dispatches": dispatches,
        "preview_repair": preview_repair,
    }


async def async_main(arguments: argparse.Namespace) -> int:
    # Cloud Run Jobs do not boot FastAPI: configure JSON logging explicitly.
    # Otherwise worker_job_* becomes unstructured text instead of jsonPayload.
    from photointel.config import get_settings
    from photointel.logging import configure_logging
    from photointel.sentry_observability import configure_sentry

    configure_logging(get_settings().log_level)
    configure_sentry("photointel-worker")
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    received_signal: list[int] = []

    def stop(signum: int) -> None:
        received_signal.append(signum)
        stopped.set()

    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop, signum)
    try:
        result = await run_finite(
            arguments.mode,
            max_jobs=arguments.max_jobs,
            deadline_seconds=arguments.deadline_seconds,
            stopped=stopped,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 128 + received_signal[0] if received_signal else 0
    finally:
        # Finite Cloud Run containers must flush error envelopes before shutdown.
        import sentry_sdk

        if sentry_sdk.is_initialized():
            await sentry_sdk.flush_async(timeout=2.0)
        if arguments.mode != "migrate":
            from photointel.database import engine

            await engine.dispose()


def main() -> None:
    arguments = parser().parse_args()
    try:
        validate_bounds(arguments.max_jobs, arguments.deadline_seconds)
    except ValueError as exc:
        parser().error(str(exc))
    raise SystemExit(asyncio.run(async_main(arguments)))


if __name__ == "__main__":
    main()
