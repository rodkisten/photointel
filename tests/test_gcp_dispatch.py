"""Fixed Cloud Run Jobs API invocation; ADC and network are mocked explicitly."""

from unittest.mock import AsyncMock

import httpx
import pytest
import respx
from photointel.errors import AppError
from photointel.services.cloud_dispatch import DispatchConfiguration, GoogleJobDispatcher


def test_cloud_dispatch_rejects_commands_urls_and_migration() -> None:
    configuration = DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    for mode in ("migrate", "worker:run", "https://evil.invalid", "worker/../../migrate"):
        with pytest.raises(ValueError):
            configuration.endpoint(mode)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_disabled_dispatch_does_not_obtain_credentials() -> None:
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1")
    )
    dispatcher._access_token = AsyncMock(
        side_effect=AssertionError("no credential calls")
    )
    with pytest.raises(AppError, match="desativado"):
        await dispatcher.dispatch("worker")


@pytest.mark.asyncio
async def test_dispatch_uses_oauth_fixed_job_empty_body_and_no_overrides() -> None:
    configuration = DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    dispatcher = GoogleJobDispatcher(configuration)
    dispatcher._access_token = AsyncMock(return_value="test-only-token")
    operation = "projects/photointel-test/locations/us-central1/operations/test-operation"
    with respx.mock() as mock:
        route = mock.post(configuration.endpoint("worker")).mock(
            return_value=httpx.Response(200, json={"name": operation})
        )
        assert await dispatcher.dispatch("worker") == operation
        request = route.calls.last.request
        assert request.headers["Authorization"] == "Bearer test-only-token"
        assert request.content == b"{}"


@pytest.mark.asyncio
async def test_dispatch_does_not_follow_redirect_or_leak_provider_message() -> None:
    configuration = DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    dispatcher = GoogleJobDispatcher(configuration)
    dispatcher._access_token = AsyncMock(return_value="test-only-token")
    with respx.mock() as mock:
        mock.post(configuration.endpoint("worker")).mock(
            return_value=httpx.Response(
                302, headers={"Location": "https://evil.invalid"}, text="private-key"
            )
        )
        with pytest.raises(AppError) as failure:
            await dispatcher.dispatch("worker")
        assert failure.value.status_code == 503
        assert "private-key" not in str(failure.value)


@pytest.mark.asyncio
async def test_dispatch_rejects_wrong_operation_project() -> None:
    configuration = DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    dispatcher = GoogleJobDispatcher(configuration)
    dispatcher._access_token = AsyncMock(return_value="test-only-token")
    with respx.mock() as mock:
        mock.post(configuration.endpoint("worker")).mock(
            return_value=httpx.Response(
                200,
                json={
                    "name": "projects/other-project/locations/us-central1/operations/"
                    + "other"
                },
            )
        )
        with pytest.raises(AppError):
            await dispatcher.dispatch("worker")
