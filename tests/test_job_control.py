"""Safe, user-requested job controls without a live external worker."""

from uuid import uuid4

import pytest

from photointel.errors import AppError
from photointel.models import Job, utcnow
from photointel.services.job_control import queue_counts, transition_job
from photointel.services import jobs as jobs_service


def job(status: str, attempts: int = 0) -> Job:
    return Job(
        id=uuid4(), status=status, job_type="thumbnail_generate",
        attempts=attempts, fence_token=17, worker_id="worker-1",
        lease_until=utcnow(), progress={"step": "processing"},
        idempotency_key=str(uuid4()),
    )


@pytest.mark.parametrize("status", ["queued", "retrying", "preparing", "running"])
def test_pause_releases_worker_and_revokes_running_fence(status):
    item = job(status, 2)
    old_fence = item.fence_token
    assert transition_job(item, "pause")
    assert item.status == "paused"
    assert item.worker_id is None
    assert item.lease_until is None
    assert item.progress == {"step": "processing"}
    assert item.finished_at is None
    assert item.fence_token == old_fence + int(status in ("preparing", "running"))
    assert item.attempts == (1 if status in ("preparing", "running") else 2)
    assert not transition_job(item, "pause")


@pytest.mark.parametrize("status", ["queued", "retrying", "preparing", "running", "paused"])
def test_cancel_prevents_late_worker_commit_and_does_not_touch_photos(status):
    item = job(status, 2)
    initial = item.fence_token
    assert transition_job(item, "cancel")
    assert item.status == "cancelled"
    assert item.lease_until is None
    assert item.worker_id is None
    assert item.finished_at is not None
    assert item.fence_token == initial + int(status in ("preparing", "running"))
    assert not transition_job(item, "cancel")


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_closed_jobs_cannot_be_paused_or_recancelled(status):
    item = job(status)
    with pytest.raises(AppError):
        transition_job(item, "pause")
    if status == "cancelled":
        assert not transition_job(item, "cancel")
    else:
        with pytest.raises(AppError):
            transition_job(item, "cancel")


def test_resume_only_paused_job_and_preserve_attempt_budget():
    item = job("paused", 2)
    assert transition_job(item, "resume")
    assert item.status == "queued"
    assert item.scheduled_at is not None
    assert item.attempts == 2
    with pytest.raises(AppError):
        transition_job(item, "resume")


def test_queue_counts_are_global_and_do_not_assume_activity_limit():
    result = queue_counts({
        "queued": 24, "retrying": 2, "running": 4,
        "paused": 13, "completed": 80, "failed": 3,
    })
    assert result["open"] == 43
    assert result["waiting"] == 26
    assert result["running"] == 4
    assert result["paused_jobs"] == 13
    assert result["terminal"] == 83
    assert result["by_status"]["cancelled"] == 0


@pytest.mark.asyncio
async def test_paused_global_queue_does_not_claim_jobs(monkeypatch):
    from types import SimpleNamespace

    async def fake_recover(_session):
        return 0

    class Session:
        async def get(self, model, key):
            return SimpleNamespace(value=True)

    monkeypatch.setattr(jobs_service, "recover_stale_jobs", fake_recover)
    assert await jobs_service.claim_jobs(Session(), "worker", 10) == []


def test_static_control_routes_precede_dynamic_job_lookup():
    from photointel.main import create_app

    routes = [route.path for route in create_app().routes]
    assert routes.index("/v1/jobs/control") < routes.index("/v1/jobs/{job_id}")
    assert "/v1/jobs/{job_id}/pause" in routes
    assert "/v1/jobs/{job_id}/resume" in routes
    assert "/v1/job-batches/{batch_id}/cancel" in routes
