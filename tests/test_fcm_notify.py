"""Firebase delivery contract tests: no credentials or real GCP required."""
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
import respx
from photointel.services import fcm_notify as fcm


def test_sender_disabled_by_default(monkeypatch):
    monkeypatch.delenv("FCM_JOB_EVENTS_ENABLED", raising=False)
    monkeypatch.setenv("FCM_PROJECT_ID", "photointel-firebase")
    assert not fcm.configured()
    monkeypatch.setenv("FCM_JOB_EVENTS_ENABLED", "true")
    assert fcm.configured()
    monkeypatch.setenv("FCM_PROJECT_ID", "invalid/project")
    assert not fcm.configured()


@pytest.mark.asyncio
async def test_disabled_sender_never_touches_database_or_network(monkeypatch):
    monkeypatch.setenv("FCM_JOB_EVENTS_ENABLED", "false")
    monkeypatch.setattr(fcm, "active_installations", AsyncMock(side_effect=AssertionError))
    assert await fcm.drain() == {"status": "disabled", "events": 0}
    await fcm.safe_notify()


def test_hashed_installation_key_and_consolidated_progress():
    fid = "c2thisIsAFirebaseID12345"
    assert fcm.device_key(fid).startswith("fcm:device:")
    assert fid not in fcm.device_key(fid)
    assert fcm.signature("running", 1, 100, 0) == fcm.signature("running", 9, 100, 0)
    assert fcm.signature("running", 9, 100, 0) != fcm.signature("running", 10, 100, 0)
    assert fcm.signature("running", 9, 100, 0) != fcm.signature("failed", 9, 100, 0)
    assert "2 falha(s)" in fcm.summary("running", 2, 10, 2)


def test_batch_scope_and_no_private_job_data():
    from types import SimpleNamespace
    batch = uuid4()
    job = SimpleNamespace(id=uuid4(), batch_id=batch)
    assert fcm.scope_for(job) == f"batch:{batch}"
    job.batch_id = None
    assert fcm.scope_for(job) == f"job:{job.id}"


@pytest.mark.asyncio
async def test_sends_webpush_via_adc_without_private_metadata(monkeypatch):
    monkeypatch.setenv("FCM_PROJECT_ID", "photointel-firebase")
    monkeypatch.setattr(fcm, "_access_token", lambda: "test-access-token")
    monkeypatch.setattr(
        fcm, "get_settings",
        lambda: type("S", (), {"frontend_origin": "https://photos.migos.club"})(),
    )
    url = "https://fcm.googleapis.com/v1/projects/photointel-firebase/messages:send"
    job_id = str(uuid4())
    batch_id = str(uuid4())
    with respx.mock(assert_all_mocked=True) as mock:
        route = mock.post(url).mock(return_value=httpx.Response(200, json={"name": "messages/1"}))
        async with httpx.AsyncClient(follow_redirects=False) as client:
            await fcm.send_message(
                client, "c2thisIsAFirebaseID12345",
                title="PhotoIntel · Processamento de fotos",
                body="Concluído · 4/4 jobs", status="completed",
                scope="batch:" + batch_id, job_id=job_id,
                event_id=37, done=4, total=4,
            )
    assert route.call_count == 1
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer test-access-token"
    import json
    body = json.loads(request.content)
    message = body["message"]
    assert message["data"]["kind"] == "job_status"
    assert message["data"]["event_id"] == "37"
    assert message["webpush"]["notification"]["tag"] == "photointel-batch-" + batch_id
    assert message["webpush"]["fcm_options"]["link"] == (
        "https://photos.migos.club/jobs?batch=" + batch_id
    )
    assert "error_details" not in str(message)
    assert "photo_metadata" not in str(message)


@pytest.mark.asyncio
async def test_fcm_does_not_follow_redirects(monkeypatch):
    monkeypatch.setenv("FCM_PROJECT_ID", "photointel-firebase")
    monkeypatch.setattr(fcm, "_access_token", lambda: "test-access-token")
    monkeypatch.setattr(
        fcm, "get_settings",
        lambda: type("S", (), {"frontend_origin": "https://photos.migos.club"})(),
    )
    with respx.mock(assert_all_mocked=True) as mock:
        mock.post("https://fcm.googleapis.com/v1/projects/photointel-firebase/messages:send").mock(
            return_value=httpx.Response(302, headers={"location": "https://example.invalid"})
        )
        async with httpx.AsyncClient(follow_redirects=False) as client:
            with pytest.raises(httpx.HTTPStatusError):
                await fcm.send_message(
                    client, "c2thisIsAFirebaseID12345", title="PhotoIntel",
                    body="Teste", status="completed", scope="job:" + str(uuid4()),
                    job_id="", event_id=0, done=1, total=1,
                )
