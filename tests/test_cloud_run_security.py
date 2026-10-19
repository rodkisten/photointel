"""A reachable run.app origin verifies identity without trusting the edge network."""

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from photointel import auth
from photointel.auth import require_bridge_access
from photointel.config import Settings
from photointel.errors import AppError
from photointel.main import create_app
from starlette.requests import Request


@pytest.fixture
def access_configuration(monkeypatch: pytest.MonkeyPatch) -> tuple[Settings, Any]:
    settings = Settings(
        _env_file=None,
        app_env="test",
        auth_mode="cloudflare",
        access_team_domain="origin-test.cloudflareaccess.com",
        access_audience="human-audience",
        access_allowed_emails=["owner@example.invalid"],
        access_bridge_audience="bridge-audience",
        access_bridge_service_tokens=["device-client-id.access"],
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    public["kid"] = "origin-key"

    async def keys(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        return [public]

    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "fetch_keys", keys)
    return settings, key


def token(key: Any, **changes: Any) -> str:
    now = datetime.now(UTC)
    claims = {
        "iss": "https://origin-test.cloudflareaccess.com",
        "aud": ["bridge-audience"],
        "sub": "",
        "common_name": "device-client-id.access",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    claims.update(changes)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "origin-key"})


def bridge_request(assertion: str | None = None) -> Request:
    headers = [(b"cf-access-jwt-assertion", assertion.encode())] if assertion else []
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/v1/bridge/status",
            "scheme": "https",
            "headers": headers,
            "query_string": b"",
            "server": ("untrusted-origin.run.app", 443),
        }
    )


async def test_service_access_has_empty_subject_and_separate_audience(
    access_configuration: tuple[Settings, Any],
) -> None:
    settings, key = access_configuration
    await require_bridge_access(bridge_request(token(key)))
    with pytest.raises(AppError):
        await auth.validate_access_token(token(key), settings)
    settings.access_bridge_service_tokens = []
    with pytest.raises(AppError) as caught:
        await require_bridge_access(bridge_request(token(key)))
    assert caught.value.status_code == 503


@pytest.mark.parametrize(
    "changes",
    [
        {"aud": "human-audience"},
        {"iss": "https://attacker.invalid"},
        {"common_name": "unapproved-client.access"},
        {"sub": "user-id", "email": "owner@example.invalid"},
        {"exp": datetime.now(UTC) - timedelta(minutes=5)},
    ],
)
async def test_invalid_service_identity_fails_closed(
    access_configuration: tuple[Settings, Any],
    changes: dict[str, Any],
) -> None:
    _, key = access_configuration
    with pytest.raises(AppError):
        await require_bridge_access(bridge_request(token(key, **changes)))


async def test_direct_origin_rejects_private_routes_before_database_or_r2(
    access_configuration: tuple[Settings, Any],
) -> None:
    app = create_app()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://untrusted-origin.run.app",
    ) as client:
        for path in [
            "/v1/assets",
            "/v1/search/facets",
            "/v1/jobs",
            "/v1/settings",
            "/v1/release",
            "/v1/setup/status",
            "/v1/verification/gates",
            "/v1/ingestion/failures",
            "/v1/apple-sync/status",
            "/v1/bridge/status",
            "/v1/assets/00000000-0000-0000-0000-000000000001/media/thumbnail_small",
        ]:
            response = await client.get(
                path,
                headers={
                    "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
                    "X-Forwarded-For": "127.0.0.1",
                    "X-Forwarded-Host": "photos.example.invalid",
                    "X-Forwarded-Proto": "https",
                    "If-None-Match": "*",
                },
            )
            assert response.status_code == 401, (path, response.text)
        # Service credentials alone cannot enroll and cannot read human endpoints.
        _, key = access_configuration
        headers = {"Cf-Access-Jwt-Assertion": token(key)}
        assert (await client.get("/v1/assets", headers=headers)).status_code == 401
        assert (await client.get("/v1/bridge/status", headers=headers)).status_code == 401
        response = await client.post("/v1/bridge/enroll", json={})
        assert response.status_code == 401
        for path in [
            "/v1/search",
            "/v1/ingestion/start",
            "/v1/jobs/reindex",
            "/v1/apple-sync/operations",
        ]:
            response = await client.post(
                path,
                json={},
                headers={
                    "Origin": access_configuration[0].frontend_origin,
                    "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
                },
            )
            assert response.status_code == 401, (path, response.text)


async def test_browser_cross_origin_is_rejected_even_with_service_jwt(
    access_configuration: tuple[Settings, Any],
) -> None:
    _, key = access_configuration
    request = bridge_request(token(key))
    request.scope["method"] = "POST"
    request.scope["headers"].append((b"origin", b"https://attacker.invalid"))
    with pytest.raises(AppError) as caught:
        await require_bridge_access(request)
    assert caught.value.status_code == 403
