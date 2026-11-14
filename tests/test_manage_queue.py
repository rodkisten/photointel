"""Regression tests for Manage's authenticated durable queue bridge."""
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks

from photointel.routers import manage_queue


@pytest.mark.asyncio
async def test_manage_read_uses_existing_queue_state(monkeypatch):
    read = AsyncMock(return_value={"paused": True, "waiting": 3, "running": 0})
    monkeypatch.setattr(manage_queue, "read_control", read)
    session = object()
    result = await manage_queue.manage_read_control(session)
    assert result == {"paused": True, "waiting": 3, "running": 0}
    read.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_manage_pause_reuses_transactional_queue_controller(monkeypatch):
    control = AsyncMock(return_value={"changed": 2, "paused": True})
    monkeypatch.setattr(manage_queue, "control_queue", control)
    session = object()
    actor = SimpleNamespace(subject="admin", email="admin@example.com")
    tasks = BackgroundTasks()
    result = await manage_queue.manage_control_queue("pause", session, actor, tasks)
    assert result == {"changed": 2, "paused": True}
    control.assert_awaited_once_with("pause", session, actor, tasks)


def test_manage_queue_requires_signed_manage_identity():
    from photointel.auth import require_manage_identity
    assert any(
        dependency.call is require_manage_identity
        for dependency in manage_queue.router.dependencies
    )
    assert {route.path for route in manage_queue.router.routes} == {
        "/manage/jobs/control", "/manage/jobs/control/{action}",
    }
