"""Authenticated job, batch and queue controls; no Cloud Run instance kill calls.

The durable database is the source of truth. Fenced cancellations prevent late
writes and leases/heartbeat notify active workers of revoked ownership.
"""

from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.auth import Identity, require_identity
from photointel.database import get_session
from photointel.errors import AppError, ErrorCode
from photointel.models import Job, JobBatch, JobEvent, Setting
from photointel.schemas import JobOut
from photointel.serializers import row_dict
from photointel.services.catalog import audit
from photointel.services.job_control import OPEN, queue_counts, transition_job
from photointel.services.job_notify import safe_notify
from photointel.services.jobs import refresh_batch
from photointel.services.runtime_settings import effective_settings

router = APIRouter(dependencies=[Depends(require_identity)], tags=["jobs"])
Session = Annotated[AsyncSession, Depends(get_session)]
Actor = Annotated[Identity, Depends(require_identity)]


def _event(session: AsyncSession, job: Job, action: str) -> None:
    session.add(JobEvent(
        job_id=job.id, status=job.status,
        payload={"action": action, "job_id": str(job.id),
                 "batch_id": str(job.batch_id) if job.batch_id else None},
    ))


async def _global_pause(session: AsyncSession, paused: bool) -> None:
    setting = await session.get(Setting, "jobs_paused", with_for_update=True)
    if setting:
        setting.value = paused
    else:
        session.add(Setting(key="jobs_paused", value=paused))
        await session.flush()


async def _wake(session: AsyncSession, jobs: list[Job]) -> bool:
    """Enqueue only the appropriate finite worker modes; never execute inline."""
    if not jobs or (await effective_settings(session)).execution_platform != "cloud_run":
        return False
    from photointel.services.outbox import enqueue_dispatch

    modes: set[str] = set()
    for job in jobs:
        if job.job_type == "icloud_discovery":
            modes.add("backfill" if job.payload.get("mode") == "backfill" else "discover")
        else:
            modes.add("worker")
    for mode in sorted(modes):
        await enqueue_dispatch(session, mode, f"jobs-resume:{mode}:{uuid4()}")
    return True


async def _after_commit(background_tasks: BackgroundTasks, dispatch: bool) -> None:
    if dispatch:
        from photointel.routers.operations import _schedule_cloud_dispatch

        _schedule_cloud_dispatch(background_tasks, "cloud_run")
    background_tasks.add_task(safe_notify)


@router.get("/jobs/control")
async def read_control(session: Session) -> dict[str, Any]:
    status_counts = dict((await session.execute(
        select(Job.status, func.count(Job.id)).group_by(Job.status)
    )).all())
    stats = queue_counts(status_counts)
    setting = await session.get(Setting, "jobs_paused")
    # Track genuine completed assets only in existing open batches. Jobs
    # outside batches have no known denominator, so do not invent a percent.
    aggregate = (await session.execute(
        select(
            func.coalesce(func.sum(JobBatch.total_assets), 0),
            func.coalesce(func.sum(JobBatch.completed), 0),
            func.coalesce(func.sum(JobBatch.failed), 0),
            func.coalesce(func.sum(JobBatch.skipped), 0),
        ).where(JobBatch.status.in_(("queued", "running", "paused", "retrying")))
    )).one()
    total = int(aggregate[0] or 0)
    finished = min(total, sum(int(value or 0) for value in aggregate[1:]))
    return {
        **stats, "paused": bool(setting and setting.value),
        "batch_progress": {
            "total": total, "finished": finished,
            "completed": int(aggregate[1] or 0),
            "failed": int(aggregate[2] or 0),
            "skipped": int(aggregate[3] or 0),
            "percent": round(finished * 100 / total) if total else None,
        },
        "count_scope": "all_jobs",
    }


@router.post("/jobs/control/{action}")
async def control_queue(
    action: Literal["pause", "resume", "cancel"],
    session: Session, identity: Actor, background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    # A global cancel also suspends future claims until explicitly resumed.
    # New job submissions remain durable, but cannot start automatically.
    await _global_pause(session, action != "resume")
    current = "paused" if action == "resume" else None
    statuses = (current,) if current else tuple(OPEN - {"paused"} if action == "pause" else OPEN)
    rows = list((await session.scalars(
        select(Job).where(Job.status.in_(statuses))
        .order_by(Job.id).with_for_update()
    )).all())
    touched: list[Job] = []
    batch_ids: set[UUID] = set()
    for job in rows:
        if transition_job(job, action):
            _event(session, job, "queue." + action)
            touched.append(job)
            if job.batch_id:
                batch_ids.add(job.batch_id)
    # Preserve status explicitly on the batch. refresh_batch respects paused
    # and cancelled, but recalculates resumed batches from actual job rows.
    if batch_ids:
        batches = list((await session.scalars(
            select(JobBatch).where(JobBatch.id.in_(batch_ids)).with_for_update()
        )).all())
        for batch in batches:
            if action == "cancel":
                batch.status = "cancelled"
            elif action == "pause" and batch.status not in ("completed", "failed", "cancelled"):
                batch.status = "paused"
            elif action == "resume" and batch.status == "paused":
                batch.status = "queued"
        for batch_id in sorted(batch_ids, key=str):
            await refresh_batch(session, batch_id)
    if action == "resume":
        # Jobs created while the queue was paused are still queued, not
        # "touched" by the resume transition. Wake them as well.
        ready = list((await session.scalars(
            select(Job).where(Job.status.in_(("queued", "retrying")))
            .order_by(Job.created_at.desc(), Job.id.desc()).limit(200)
        )).all())
        dispatch = await _wake(session, [*touched, *ready])
    else:
        dispatch = False
    audit(session, identity, "jobs.queue." + action, affected=len(touched))
    await session.commit()
    await _after_commit(background_tasks, dispatch)
    return {"changed": len(touched), **(await read_control(session))}


async def _control_job(
    job_id: UUID, action: Literal["pause", "resume"],
    session: AsyncSession, identity: Identity, background_tasks: BackgroundTasks,
) -> JobOut:
    job = await session.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if job is None:
        raise AppError(ErrorCode.NOT_FOUND, "Job não encontrado", 404)
    if action == "resume":
        global_paused = await session.get(Setting, "jobs_paused")
        if global_paused and global_paused.value:
            raise AppError(ErrorCode.INVALID_REQUEST, "Retome a fila global antes deste job", 409)
        batch = await session.get(JobBatch, job.batch_id) if job.batch_id else None
        if batch and batch.status in ("paused", "cancelled"):
            raise AppError(ErrorCode.INVALID_REQUEST, "Retome primeiro o lote deste job", 409)
    changed = transition_job(job, action)
    if changed:
        _event(session, job, "job." + action)
        await refresh_batch(session, job.batch_id)
    dispatch = await _wake(session, [job]) if action == "resume" and changed else False
    audit(session, identity, "job." + action, job.asset_id, job_id=str(job.id))
    await session.commit()
    await _after_commit(background_tasks, dispatch)
    return JobOut.model_validate(job)


@router.post("/jobs/{job_id}/pause", response_model=JobOut)
async def pause_job(
    job_id: UUID, session: Session, identity: Actor,
    background_tasks: BackgroundTasks,
) -> JobOut:
    return await _control_job(job_id, "pause", session, identity, background_tasks)


@router.post("/jobs/{job_id}/resume", response_model=JobOut)
async def resume_job(
    job_id: UUID, session: Session, identity: Actor,
    background_tasks: BackgroundTasks,
) -> JobOut:
    return await _control_job(job_id, "resume", session, identity, background_tasks)


@router.post("/job-batches/{batch_id}/cancel")
async def cancel_batch(
    batch_id: UUID, session: Session, identity: Actor, background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    rows = list((await session.scalars(
        select(Job).where(Job.batch_id == batch_id, Job.status.in_(tuple(OPEN)))
        .order_by(Job.id).with_for_update()
    )).all())
    batch = await session.scalar(
        select(JobBatch).where(JobBatch.id == batch_id).with_for_update()
    )
    if batch is None:
        raise AppError(ErrorCode.NOT_FOUND, "Lote não encontrado", 404)
    if batch.status in ("completed", "failed"):
        raise AppError(ErrorCode.INVALID_REQUEST, "Lote já finalizado", 409)
    for job in rows:
        if transition_job(job, "cancel"):
            _event(session, job, "batch.cancel")
    batch.status = "cancelled"
    await refresh_batch(session, batch_id)
    audit(session, identity, "batch.cancel", batch_id=str(batch_id), affected=len(rows))
    await session.commit()
    await _after_commit(background_tasks, False)
    return {"changed": len(rows), **row_dict(batch)}
