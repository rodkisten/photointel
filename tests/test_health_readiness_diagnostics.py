"""Safe, independent Neon/R2 readiness diagnostics without provider secrets."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import httpx
import pytest

from photointel import main
from photointel.storage import S3Storage


@pytest.mark.parametrize(
    ("db_fails", "r2_fails", "expected_code", "events"),
    [
        (False, False, 200, []),
        (True, False, 503, ["readiness_neon_failed"]),
        (False, True, 503, ["readiness_r2_failed"]),
        (True, True, 503, ["readiness_neon_failed", "readiness_r2_failed"]),
    ],
)
async def test_public_readiness_logs_only_component_and_exception_class(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    db_fails: bool,
    r2_fails: bool,
    expected_code: int,
    events: list[str],
) -> None:
    password = "private-connection-password-never-log"

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def execute(self, query):
            if db_fails:
                raise ConnectionError(password)
            return None

    monkeypatch.setattr(main, "SessionLocal", Session)

    storage = object.__new__(S3Storage)
    storage.bucket = "synthetic-test-bucket"

    def head_bucket(*, Bucket: str):
        assert Bucket == storage.bucket
        if r2_fails:
            raise PermissionError(password)
        return {}

    storage.client = SimpleNamespace(head_bucket=head_bucket)
    monkeypatch.setattr(main, "get_storage", lambda: storage)

    caplog.set_level(logging.ERROR, logger="photointel.api")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.create_app()),
        base_url="https://photos.example.invalid",
    ) as client:
        response = await client.get("/health/ready")
    assert response.status_code == expected_code
    assert all(event in caplog.text for event in events)
    assert ("readiness_neon_failed" in caplog.text) == db_fails
    assert ("readiness_r2_failed" in caplog.text) == r2_fails
    assert password not in caplog.text
    assert password not in response.text
    assert "synthetic-test-bucket" not in response.text
    if expected_code == 200:
        assert response.json() == {"status": "ready"}
    else:
        assert response.json().get("error") is not None
