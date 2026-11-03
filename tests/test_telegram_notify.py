"""Telegram job notifications: formatting, redaction and transport, without external services."""
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
import respx
from photointel.models import Job, JobBatch, JobEvent
from photointel.services import job_notify
from photointel.services import telegram_notify as telegram


def example(status: str = "failed") -> tuple[Job, JobEvent, JobBatch]:
    job = Job(
        id=uuid4(), job_type="thumbnail_generate", batch_id=uuid4(),
        payload={"correlation_id": str(uuid4()), "token": "never-send-me"},
        status=status, attempts=2, maximum_attempts=3, error_code="MEDIA_DECODE_FAILED",
        error_details={
            "exception_type": "ValueError",
            "traceback": ["worker.py:632:_execute_claimed", "media.py:109:decode"],
            "sentry_event_id": "a" * 32,
            "message": "Secret bearer token should not be forwarded",
        },
    )
    event = JobEvent(
        id=100, job_id=job.id, status=status,
        payload={"error_code": "MEDIA_DECODE_FAILED", "exception_type": "ValueError",
                 "traceback": ["worker.py:632:_execute_claimed", "media.py:109:decode"],
                 "sentry_event_id": "a" * 32},
    )
    batch = JobBatch(id=job.batch_id, name="Reindex_<2026> & previews")
    return job, event, batch


@pytest.mark.parametrize("status", sorted(telegram.STATES))
def test_all_statuses_receive_markdown_and_deep_links(status, monkeypatch):
    monkeypatch.setenv("GCP_PROJECT_ID", "photointel")
    monkeypatch.setenv("API_ORIGIN", "https://photos.migos.club")
    monkeypatch.setenv("FRONTEND_ORIGIN", "https://photos.migos.club")
    job, event, batch = example(status)
    text, buttons = telegram.format_message(
        job, event, batch, {"queued": 10, "running": 4, "completed": 5, "failed": 1}
    )
    assert "PhotoIntel" in text
    assert "6/20" in text
    assert "Reindex\\_\\<2026\\>" not in text  # MarkdownV2: <> are harmless literals
    assert "Reindex\\_\\<" not in text
    assert "Reindex\\_" in text
    assert "never-send-me" not in text
    assert "bearer token" not in text
    assert buttons[0][0]["url"] == "https://photos.migos.club/jobs"
    assert buttons[-1][0]["url"].startswith("https://photos-manage.migos.club/?tab=logs&source=gcp")
    if status in telegram.ERROR_STATES:
        assert "ValueError" in text
        assert "MEDIA_DECODE_FAILED" in text
        assert "worker.py:632:_execute_claimed" in text
        assert "Sentry" in buttons[1][0]["text"]
        assert buttons[1][0]["url"].endswith("a" * 32)
    else:
        assert "Traceback completo" not in text
        assert len(buttons) == 2


def test_oversized_traceback_is_bounded():
    job, event, batch = example()
    event.payload["traceback"] = ["worker.py:999:" + "x" * 100] * 128
    text, links = telegram.format_message(job, event, batch, {"failed": 1})
    assert len(text) < 4096
    assert len(links) == 3


def test_configuration_requires_explicit_switch_and_safe_url(monkeypatch):
    monkeypatch.setenv("TELEGRAM_NOTIFICATION_API_TOKEN", "X" * 32)
    monkeypatch.setenv("TELEGRAM_NOTIFICATION_CHAT_ID", "-100123456:73")
    monkeypatch.setenv("TELEGRAM_NOTIFICATION_URL", "https://relay.example/notifications/send")
    monkeypatch.setenv("TELEGRAM_JOB_EVENTS_ENABLED", "false")
    assert telegram.credentials() is None
    monkeypatch.setenv("TELEGRAM_JOB_EVENTS_ENABLED", "true")
    assert telegram.credentials() == (
        "https://relay.example/notifications/send", "X" * 32, "-100123456:73",
    )
    for url in (
        "http://relay.example/notifications/send",
        "https://relay.example/notifications/send?token=bad",
        "https://user:pass@relay.example/notifications/send",
        "https://relay.example/other",
    ):
        monkeypatch.setenv("TELEGRAM_NOTIFICATION_URL", url)
        assert telegram.credentials() is None


@pytest.mark.asyncio
async def test_relay_delivery_uses_bearer_and_rejects_error_without_redirects():
    endpoint = "https://relay.example/notifications/send"
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.post(endpoint).mock(return_value=httpx.Response(200, json={"ok": True}))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            await telegram.deliver(client, (endpoint, "T" * 32, "42"), "*hello*", [])
        request = route.calls.last.request
        assert request.headers["authorization"] == "Bearer " + "T" * 32
        assert b"MarkdownV2" in request.content
        assert b'"notification_key"' not in request.content  # legacy caller remains compatible

    with respx.mock(assert_all_mocked=True) as mock:
        mock.post(endpoint).mock(return_value=httpx.Response(502, json={"ok": False}))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            with pytest.raises(httpx.HTTPStatusError):
                await telegram.deliver(client, (endpoint, "T" * 32, "42"), "test", [])


@pytest.mark.asyncio
async def test_telegram_runs_independently_from_iphone_provider(monkeypatch):
    monkeypatch.setenv("NOTIFY_JOB_EVENTS_ENABLED", "false")
    called = AsyncMock()
    monkeypatch.setattr(telegram, "safe_notify", called)
    await job_notify.safe_notify()
    called.assert_awaited_once()


@pytest.mark.asyncio
async def test_disabled_telegram_never_uses_database_or_network(monkeypatch):
    monkeypatch.setenv("TELEGRAM_JOB_EVENTS_ENABLED", "false")
    monkeypatch.setattr(telegram, "claim_cursor", AsyncMock(side_effect=AssertionError))
    assert await telegram.drain() == {"status": "disabled", "events": 0}
    await telegram.safe_notify()


@pytest.mark.asyncio
async def test_editable_batch_notification_sends_stable_key_and_sequence():
    endpoint = "https://relay.example/notifications/send"
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.post(endpoint).mock(return_value=httpx.Response(
            200, json={"ok": True, "message_id": 123, "edited": True,
                       "notification_key": "photointel:batch:123456"},
        ))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            await telegram.deliver(
                client, (endpoint, "T" * 32, "-100123:73"),
                "*running*", [], "photointel:batch:123456", 45,
            )
        request = route.calls.last.request
        assert b'"notification_key":"photointel:batch:123456"' in request.content
        assert b'"sequence":45' in request.content
        assert request.headers["authorization"] == "Bearer " + "T" * 32


def test_editable_scope_per_batch_or_standalone_job():
    job, event, batch = example("running")
    assert telegram.notification_scope(job) == "photointel:batch:" + str(batch.id)
    job.batch_id = None
    assert telegram.notification_scope(job) == "photointel:job:" + str(job.id)


@pytest.mark.asyncio
async def test_rejects_old_relay_response_without_edit_ack():
    endpoint = "https://relay.example/notifications/send"
    with respx.mock(assert_all_mocked=True) as mock:
        mock.post(endpoint).mock(return_value=httpx.Response(
            200, json={"ok": True, "message_id": 1},
        ))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            with pytest.raises(ValueError, match="editable notification"):
                await telegram.deliver(
                    client, (endpoint, "T" * 32, "42"), "*running*", [],
                    "photointel:batch:123456", 101,
                )


@pytest.mark.asyncio
async def test_capability_probe_rejects_legacy_relay_before_sending():
    endpoint = "https://relay.example/notifications/send"
    capabilities = "https://relay.example/notifications/capabilities"
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.get(capabilities).mock(return_value=httpx.Response(
            200, json={"ok": True, "version": "editable-v1",
                       "features": ["upsert_notification_key"]},
        ))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            await telegram.require_editable_relay(client, (endpoint, "T" * 32, "42"))
        assert route.called
        assert route.calls.last.request.headers["authorization"] == "Bearer " + "T" * 32

    with respx.mock(assert_all_mocked=True) as mock:
        mock.get(capabilities).mock(return_value=httpx.Response(404))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            with pytest.raises(httpx.HTTPStatusError):
                await telegram.require_editable_relay(client, (endpoint, "T" * 32, "42"))


def test_failed_job_context_survives_later_successful_sibling():
    failed_job, failed_event, batch = example("failed")
    success_job, success_event, _ = example("completed")
    success_job.batch_id = batch.id
    message, buttons = telegram.format_message(
        success_job, success_event, batch,
        {"completed": 1, "failed": 1},
        latest_failure=(failed_job, failed_event),
    )
    assert "Lote com falhas" in message
    assert "MEDIA_DECODE_FAILED" in message
    assert str(failed_job.id) in message
    assert buttons[1][0]["url"].endswith("a" * 32)
    assert str(failed_job.id) in buttons[-1][0]["url"]
