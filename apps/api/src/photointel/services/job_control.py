"""Atomic, durable job-control state transitions shared by UI and batch endpoints.

Cancellation/pause revokes worker ownership and increments the fence for running
work, preventing a late worker from committing results. The worker heartbeat
also cooperatively cancels the in-flight coroutine when ownership is revoked.
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from photointel.errors import AppError, ErrorCode
from photointel.models import Job, utcnow

RUNNABLE = frozenset(("queued", "retrying"))
IN_FLIGHT = frozenset(("preparing", "running"))
OPEN = RUNNABLE | IN_FLIGHT | {"paused"}
DONE = frozenset(("completed", "failed", "cancelled"))


def transition_job(job: Job, action: str, now: datetime | None = None) -> bool:
    """Mutate a row already locked by its transaction. Idempotent on same state."""
    current = job.status
    if action == "pause":
        if current == "paused":
            return False
        if current not in RUNNABLE | IN_FLIGHT:
            raise AppError(ErrorCode.INVALID_REQUEST, "Este job não pode ser pausado", 409)
        target = "paused"
    elif action == "resume":
        if current != "paused":
            raise AppError(ErrorCode.INVALID_REQUEST, "Apenas jobs pausados podem ser retomados", 409)
        target = "queued"
    elif action == "cancel":
        if current == "cancelled":
            return False
        if current not in OPEN:
            raise AppError(ErrorCode.INVALID_REQUEST, "Este job já terminou", 409)
        target = "cancelled"
    else:
        raise ValueError("Unsupported job control action")

    moment = now or utcnow()
    if current in IN_FLIGHT:
        # The worker can no longer commit its previous claim. A user-requested
        # interruption must not exhaust the automatic failure attempt budget.
        job.fence_token += 1
        job.attempts = max(0, job.attempts - 1)
    job.status = target
    job.worker_id = None
    job.lease_until = None
    if target == "queued":
        job.scheduled_at = moment
        job.finished_at = None
        job.error_code = None
        job.error_details = None
    elif target == "cancelled":
        job.finished_at = moment
    else:
        job.finished_at = None
    return True


def queue_counts(raw: Mapping[str, int]) -> dict[str, Any]:
    """Expose true counts, never the 24-row activity feed limit as a total."""
    counts = {name: max(0, int(raw.get(name, 0))) for name in (
        "queued", "retrying", "preparing", "running",
        "paused", "completed", "failed", "cancelled",
    )}
    waiting = counts["queued"] + counts["retrying"]
    running = counts["preparing"] + counts["running"]
    return {
        "by_status": counts,
        "waiting": waiting,
        "running": running,
        "paused_jobs": counts["paused"],
        "open": waiting + running + counts["paused"],
        "terminal": counts["completed"] + counts["failed"] + counts["cancelled"],
    }
