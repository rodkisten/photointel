"""Notify! API lifecycle: opt-in, batch grouping, bounded requests, and no secrets in logs."""
from unittest.mock import AsyncMock

import httpx
import pytest
import respx

from photointel.services import job_notify as notify


def test_default_is_disabled_and_never_uses_partial_credentials(monkeypatch):
    monkeypatch.delenv("NOTIFY_JOB_EVENTS_ENABLED", raising=False)
    monkeypatch.setenv("NOTIFY_DEVICE_ID", "IODEVICE123456")
    monkeypatch.setenv("NOTIFY_TOKEN", "SECRET123456")
    assert notify.credentials() is None
    monkeypatch.setenv("NOTIFY_JOB_EVENTS_ENABLED", "true")
    monkeypatch.delenv("NOTIFY_TOKEN")
    assert notify.credentials() is None


@pytest.mark.asyncio
async def test_disabled_notify_has_no_database_or_network_access(monkeypatch):
    monkeypatch.setenv("NOTIFY_JOB_EVENTS_ENABLED", "false")
    monkeypatch.setattr(notify, "claim_cursor", AsyncMock(side_effect=AssertionError))
    assert await notify.drain_job_notifications() == {"status": "disabled", "events": 0}
    await notify.safe_notify()


def test_batch_scope_and_real_progress():
    from uuid import uuid4
    job, batch = uuid4(), uuid4()
    assert notify.scope_for(job, batch) == f"batch:{batch}"
    assert notify.scope_for(job, None) == f"job:{job}"
    assert notify.segments(0, 1) == {"steps": 3, "step": 0}
    assert notify.segments(1, 1) == {"steps": 3, "step": 3}
    assert notify.segments(5, 50) == {"steps": 20, "step": 2}
    assert notify.segments(50, 50) == {"steps": 20, "step": 20}


@pytest.mark.asyncio
async def test_notify_sends_correct_live_activity_lifecycle_without_redirect():
    url = "https://push.getnotifyapp.com/live-activity/IODEVICE123456"
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.post(url).mock(return_value=httpx.Response(
            200, json={"success": True, "activityId": "LA7Q2ZKM"}
        ))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            result = await notify.send(
                client, "IODEVICE123456", "SECRET123456",
                {"title": "PhotoIntel · Importação iCloud", "steps": 3, "step": 0},
                new=True,
            )
        assert result["activityId"] == "LA7Q2ZKM"
        assert "new=1" in str(route.calls.last.request.url)
        assert "SECRET123456" in str(route.calls.last.request.url)


@pytest.mark.asyncio
async def test_notify_rejects_redirects_and_does_not_follow_provider(monkeypatch):
    with respx.mock(assert_all_mocked=True) as mock:
        mock.post("https://push.getnotifyapp.com/live-activity/IODEVICE123456").mock(
            return_value=httpx.Response(
                302, headers={"location": "https://example.invalid/credentials"}
            )
        )
        async with httpx.AsyncClient(follow_redirects=False) as client:
            with pytest.raises(httpx.HTTPStatusError):
                await notify.send(
                    client, "IODEVICE123456", "SECRET123456", {}, new=True
                )


@pytest.mark.asyncio
async def test_notify_groups_batch_pushes_instead_of_spamming_each_photo():
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.post(
            "https://push.getnotifyapp.com/notify-json/IODEVICE123456"
        ).mock(return_value=httpx.Response(200, json={"success": True}))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            await notify.send_push(
                client, "IODEVICE123456", "SECRET123456",
                "PhotoIntel · Importação iCloud", "Concluído · 100/100 jobs",
                "batch:00000000-0000-0000-0000-000000000001",
            )
        assert route.call_count == 1
        assert b"Conclu" in route.calls.last.request.content
        assert b"photointel-batch-" in route.calls.last.request.content


@pytest.mark.asyncio
async def test_cursor_delivery_limit_fails_closed():
    for limit in (0, -1, 501):
        with pytest.raises(ValueError):
            await notify.drain_job_notifications(limit=limit)
