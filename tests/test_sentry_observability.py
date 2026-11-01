"""Offline verification: exact Sentry links and zero-private-data telemetry."""
from __future__ import annotations

from uuid import uuid4

import pytest
from photointel.sentry_observability import (
    _scrub,
    event_id,
    sentry_organization,
)


def test_event_id_never_accepts_unknown_or_injected_paths() -> None:
    assert event_id("a" * 32) == "a" * 32
    assert event_id("A" * 32) == "a" * 32
    for value in ("../issues/42", "a" * 31, "a" * 33, str(uuid4()), None):
        assert event_id(value) is None


def test_telemetry_redacts_all_photo_metadata_and_exception_values() -> None:
    event = {
        "request": {"url": "https://private.example.com/photo?signature=secret"},
        "user": {"email": "private@example.com"},
        "breadcrumbs": {"values": [{"message": "secret"}]},
        "extra": {"photo": "PRIVATE"},
        "contexts": {"device": "iPhone"},
        "tags": {"correlation_id": "safe-id", "filename": "private.heic"},
        "exception": {"values": [{
            "type": "ValueError", "value": "password=SECRET",
            "stacktrace": {"frames": [{
                "filename": "worker.py", "lineno": 42,
                "abs_path": "/home/private/secret.py",
                "vars": {"secret": "SECRET"},
                "context_line": "password=SECRET",
            }]},
        }]},
    }
    clean = _scrub(event, {})
    serialized = str(clean)
    for value in ("SECRET", "PRIVATE", "private.heic", "private@example.com"):
        assert value not in serialized
    assert clean["exception"]["values"][0]["type"] == "ValueError"
    assert clean["exception"]["values"][0]["stacktrace"]["frames"][0]["lineno"] == 42


@pytest.mark.asyncio
async def test_exact_sentry_event_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    from photointel.routers import observability

    id_ = "f" * 32
    monkeypatch.setenv("SENTRY_ORG", "photointel")
    monkeypatch.setenv("SENTRY_API_TOKEN", "unit-test-only-token")

    class Result:
        status_code = 200
        content = b'{"groupId":"24680","projectSlug":"photointel-api"}'

        def json(self):
            return {"groupId": "24680", "projectSlug": "photointel-api"}

    class Client:
        def __init__(self, *args, **kwargs):
            assert kwargs["follow_redirects"] is False

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, *, headers):
            assert url.endswith("/eventids/" + id_ + "/")
            assert headers["Authorization"] == "Bearer unit-test-only-token"
            return Result()

    monkeypatch.setattr(observability.httpx, "AsyncClient", Client)
    redirect = await observability.sentry_event_redirect(id_)
    assert redirect.status_code == 302
    assert redirect.headers["location"].endswith("/issues/24680/events/" + id_ + "/")
    assert "unit-test-only-token" not in redirect.headers["location"]


def test_sentry_slug_validation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SENTRY_ORG", "invalid/../org")
    assert sentry_organization() is None
