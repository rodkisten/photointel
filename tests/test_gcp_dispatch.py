"""Fixed Cloud Run Jobs API invocation; ADC and network are mocked explicitly."""

from unittest.mock import AsyncMock, Mock

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


def test_adc_resolution_and_refresh_have_a_bounded_transport(monkeypatch) -> None:
    import google.auth
    from google.auth.transport.requests import Request

    calls = []

    def bounded_request(_self, *args, **kwargs):
        calls.append(kwargs["timeout"])
        return Mock()

    credentials = Mock(valid=False, token="test-only-refreshed-token")
    credentials.refresh.side_effect = lambda request: request(
        "https://metadata.google.internal/test-only", timeout=500
    )

    def application_default(*, scopes, request):
        assert scopes == ["https://www.googleapis.com/auth/cloud-platform"]
        request("https://metadata.google.internal/test-only", timeout=500)
        return credentials, "photointel-test"

    monkeypatch.setattr(Request, "__call__", bounded_request)
    monkeypatch.setattr(google.auth, "default", application_default)
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    )
    assert dispatcher._refresh_credentials() == "test-only-refreshed-token"
    assert calls == [10, 10]


@pytest.mark.asyncio
async def test_credential_failure_suppresses_sensitive_exception_context() -> None:
    dispatcher = GoogleJobDispatcher(
        DispatchConfiguration("photointel-test", "us-central1", enabled=True)
    )
    dispatcher._access_token = AsyncMock(
        side_effect=RuntimeError("credential-provider-private-details")
    )
    with pytest.raises(AppError) as failure:
        await dispatcher.dispatch("worker")
    assert failure.value.status_code == 503
    assert "private-details" not in str(failure.value)
    assert failure.value.__cause__ is None
    assert failure.value.__suppress_context__ is True
