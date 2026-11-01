"""Offline regressions for manual iCloud import without a running Scheduler.

No Google credentials, Apple login, Cloud Run invocation or database required.
"""

import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import BackgroundTasks

from photointel.routers import operations
from photointel.services.task_runner import dispatch_ready_worker_followup


def test_manual_import_wakes_the_durable_outbox_after_commit() -> None:
    tasks = BackgroundTasks()
    operations._schedule_cloud_dispatch(tasks, "cloud_run")
    assert len(tasks.tasks) == 1
    task = tasks.tasks[0]
    assert task.func.__name__ == "drain_outbox"
    assert task.kwargs == {"limit": 3, "deadline_seconds": 20}
    # No wakeup for the local Compose worker.
    operations._schedule_cloud_dispatch(tasks, "vps")
    assert len(tasks.tasks) == 1
    source = inspect.getsource(operations.start_ingestion)
    assert source.count("_schedule_cloud_dispatch(") == 2
    assert source.index("await session.commit()") < source.index(
        "_schedule_cloud_dispatch("
    )
    assert source.index("await session.commit()", source.index("audit(")) < source.rindex(
        "_schedule_cloud_dispatch("
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["discover", "backfill", "worker"])
async def test_finite_job_wakes_non_discovery_jobs_without_scheduler(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    from photointel import config, database
    from photointel.services import outbox

    events = []
    pending = uuid4()

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def scalar(self, statement):
            assert "icloud_discovery" in str(statement)
            events.append("check")
            return pending

        async def commit(self):
            events.append("commit")

    async def enqueue(session, mode, key):
        assert mode == "worker"
        assert key.startswith("finite-worker-wakeup:")
        events.append("enqueue")

    async def drain(**kwargs):
        assert events[-1] == "commit"
        assert kwargs == {"limit": 3, "deadline_seconds": 14.0}
        events.append("dispatch")
        return {"status": "completed", "claimed": 1, "dispatched": 1, "retrying": 0}

    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(execution_platform="cloud_run"))
    monkeypatch.setattr(database, "SessionLocal", lambda: Session())
    monkeypatch.setattr(outbox, "enqueue_dispatch", enqueue)
    monkeypatch.setattr(outbox, "drain_outbox", drain)

    result = await dispatch_ready_worker_followup(mode, 15)
    assert result["status"] == "completed"
    assert result["dispatched"] == 1
    assert events == ["check", "enqueue", "commit", "dispatch"]


@pytest.mark.asyncio
async def test_finite_job_does_not_wake_with_no_work_or_local_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel import config, database
    from photointel.services import outbox

    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def scalar(self, statement):
            return None
        async def commit(self):
            return None

    enqueue = AsyncMock(side_effect=AssertionError("unexpected enqueue"))
    drain = AsyncMock(side_effect=AssertionError("unexpected dispatch"))
    monkeypatch.setattr(outbox, "enqueue_dispatch", enqueue)
    monkeypatch.setattr(outbox, "drain_outbox", drain)
    monkeypatch.setattr(database, "SessionLocal", lambda: Session())
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(execution_platform="cloud_run"))
    result = await dispatch_ready_worker_followup("backfill", 15)
    assert result["status"] == "no_runnable_worker_jobs"

    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(execution_platform="vps"))
    assert (await dispatch_ready_worker_followup("backfill", 15))["status"] == "not_cloud_run"
    assert (await dispatch_ready_worker_followup("maintenance", 15))["status"] == "not_applicable"
    enqueue.assert_not_called()
    drain.assert_not_called()


@pytest.mark.asyncio
async def test_worker_followup_remains_durable_when_job_deadline_is_reached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from photointel import config, database
    from photointel.services import outbox

    class Session:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def scalar(self, statement):
            return uuid4()
        async def commit(self):
            return None

    enqueue = AsyncMock()
    drain = AsyncMock(side_effect=AssertionError("must not dispatch past deadline"))
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(execution_platform="cloud_run"))
    monkeypatch.setattr(database, "SessionLocal", lambda: Session())
    monkeypatch.setattr(outbox, "enqueue_dispatch", enqueue)
    monkeypatch.setattr(outbox, "drain_outbox", drain)
    assert (await dispatch_ready_worker_followup("backfill", 0))["status"] == "queued_for_retry"
    enqueue.assert_awaited_once()
    drain.assert_not_called()
