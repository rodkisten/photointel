"""Offline contracts for the authenticated Cloud Logging incident inspector."""
import json
from uuid import uuid4

import pytest

from photointel.services.cloud_logs import canonical_id, normalize_entry, read_incident


def entry(identifier: str, *, payload: dict | None = None) -> dict:
    fields = {"correlation_id": identifier, "event": "api_http_error",
              "error_code": "INVALID_REQUEST", "reason": "NO_ELIGIBLE_ASSETS",
              "status_code": 409, "method": "POST",
              "route_group": "/v1/jobs/reindex"}
    if payload:
        fields.update(payload)
    return {
        "resource": {"type": "cloud_run_revision",
                     "labels": {"service_name": "photointel-api"}},
        "severity": "WARNING", "timestamp": "2026-11-01T14:52:00Z",
        "textPayload": json.dumps(fields),
    }


def test_cloud_logs_whitelist_no_payload_leak() -> None:
    identifier = str(uuid4())
    raw = entry(identifier, payload={
        "password": "NEVER_SHOW_ME",
        "authorization": "Bearer NEVER_SHOW_ME",
        "customer_photo": "private.jpg",
        "reason": "NO_ELIGIBLE_ASSETS",
    })
    result = normalize_entry(raw, identifier)
    assert result is not None
    assert result["status_code"] == 409
    assert result["reason"] == "NO_ELIGIBLE_ASSETS"
    assert result["route_group"] == "/v1/jobs/reindex"
    assert "NEVER_SHOW_ME" not in json.dumps(result)
    assert "private.jpg" not in json.dumps(result)
    assert set(result) == {
        "timestamp", "severity", "service", "event", "status_code",
        "error_code", "reason", "method", "route_group", "exception_type",
        "job_type", "job_id",
    }


def test_reject_mismatched_ids_bad_service_and_suspicious_reason() -> None:
    identifier = str(uuid4())
    assert canonical_id(identifier) == identifier
    assert canonical_id("invalid OR true") is None
    assert normalize_entry(entry(str(uuid4())), identifier) is None
    invalid = entry(identifier, payload={"reason": "private-user@example.com"})
    assert normalize_entry(invalid, identifier)["reason"] is None
    invalid["resource"]["labels"]["service_name"] = "other-service"
    assert normalize_entry(invalid, identifier) is None


@pytest.mark.asyncio
async def test_cloud_logs_fixed_scope_and_bounded_results(monkeypatch: pytest.MonkeyPatch) -> None:
    from photointel.services import cloud_logs

    identifier = str(uuid4())
    outbound: dict = {}

    class FakeResponse:
        content = b"{}"

        def raise_for_status(self):
            pass

        def json(self):
            return {"entries": [entry(identifier) for _ in range(32)]}

    class FakeClient:
        def __init__(self, **kwargs):
            assert kwargs["follow_redirects"] is False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, url, headers, json):
            outbound.update({"url": url, "headers": headers, "body": json})
            return FakeResponse()

    monkeypatch.setattr(cloud_logs, "_get_token", lambda: "TEST_TOKEN")
    monkeypatch.setattr(cloud_logs.httpx, "AsyncClient", FakeClient)
    result = await read_incident(identifier)
    assert len(result) == 20
    assert outbound["url"] == "https://logging.googleapis.com/v2/entries:list"
    assert outbound["body"]["resourceNames"] == ["projects/photointel"]
    assert outbound["body"]["pageSize"] == 30
    assert f'SEARCH("{identifier}")' in outbound["body"]["filter"]
    assert 'resource.labels.service_name="photointel-api"' in outbound["body"]["filter"]
    assert "TEST_TOKEN" not in json.dumps(result)
