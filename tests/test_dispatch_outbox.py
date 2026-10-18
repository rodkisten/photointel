"""Pure retry/disabled-mode regressions; no cloud calls or spending."""

from unittest.mock import AsyncMock

import pytest
from photointel.services.cloud_dispatch import DispatchConfiguration, GoogleJobDispatcher
from photointel.services.outbox import drain_outbox, retry_delay


def test_outbox_backoff_is_bounded_and_has_jitter() -> None:
    for attempt in (1, 2, 5, 8, 10000):
        samples = {retry_delay(attempt) for _ in range(10)}
        assert len(samples) > 1
        assert all(0 < delay <= 900 for delay in samples)


@pytest.mark.asyncio
async def test_disabled_outbox_does_not_contact_google_or_database(monkeypatch) -> None:
    monkeypatch.setenv("GCP_JOB_DISPATCH_ENABLED", "false")
    result = await drain_outbox()
    assert result == {"status": "disabled", "claimed": 0, "dispatched": 0, "retrying": 0}
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1")
    )
    dispatcher.dispatch = AsyncMock(side_effect=AssertionError("no external calls"))
    assert (await drain_outbox(dispatcher=dispatcher))["status"] == "disabled"


@pytest.mark.asyncio
async def test_outbox_rejects_unbounded_draining() -> None:
    for limit, seconds in ((0, 30), (101, 30), (1, 0), (1, 301)):
        with pytest.raises(ValueError):
            await drain_outbox(limit=limit, deadline_seconds=seconds)
