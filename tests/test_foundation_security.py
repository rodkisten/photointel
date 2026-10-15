"""Cryptographic authentication and fail-closed deployment configuration."""

from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import ValidationError
from starlette.requests import Request

from photointel import auth
from photointel.auth import check_origin, require_identity, validate_access_token
from photointel.config import Settings
from photointel.errors import AppError
from photointel.logging import redact_value


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None, app_env="test", auth_mode="cloudflare",
        access_team_domain="unit.cloudflareaccess.com", access_audience="unit-audience",
        access_allowed_emails=["owner@example.invalid"],
    )


@pytest.fixture(scope="module")
def signing_key() -> Any:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def access_token(key: Any, **changes: Any) -> str:
    now = datetime.now(UTC)
    claims = {
        "iss": "https://unit.cloudflareaccess.com", "aud": ["unit-audience"],
        "sub": "owner-uuid", "email": "owner@example.invalid",
        "iat": now, "exp": now + timedelta(minutes=5),
    }
    claims.update(changes)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "unit-key"})


def request(method: str = "GET", **headers: str) -> Request:
    return Request({
        "type": "http", "method": method, "path": "/v1/assets", "scheme": "https",
        "headers": [(name.lower().encode(), value.encode()) for name, value in headers.items()],
        "query_string": b"", "server": ("photos.example.invalid", 443),
    })


@pytest.fixture
def known_jwks(signing_key: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    key = jwt.algorithms.RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    key["kid"] = "unit-key"

    async def keys(*_: Any, **__: Any) -> list[dict[str, Any]]:
        return [key]

    monkeypatch.setattr(auth, "fetch_keys", keys)


async def test_access_verifies_real_signature_and_allowlist(
    settings: Settings, signing_key: Any, known_jwks: None,
) -> None:
    identity = await validate_access_token(access_token(signing_key), settings)
    assert identity.subject == "owner-uuid"
    assert identity.email == "owner@example.invalid"
    with pytest.raises(AppError) as caught:
        await validate_access_token(
            access_token(signing_key, email="intruder@example.invalid"), settings,
        )
    assert caught.value.status_code == 403


@pytest.mark.parametrize("changes", [
    {"aud": "other-audience"}, {"iss": "https://evil.invalid"},
    {"exp": datetime.now(UTC) - timedelta(minutes=5)}, {"sub": None},
])
async def test_access_rejects_invalid_claims(
    settings: Settings, signing_key: Any, known_jwks: None, changes: dict[str, Any],
) -> None:
    with pytest.raises(AppError) as caught:
        await validate_access_token(access_token(signing_key, **changes), settings)
    assert caught.value.status_code == 401


async def test_access_rejects_forged_signature(
    settings: Settings, known_jwks: None,
) -> None:
    forged_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(AppError) as caught:
        await validate_access_token(access_token(forged_key), settings)
    assert caught.value.status_code == 401


async def test_unverified_identity_header_does_not_authenticate(
    settings: Settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    with pytest.raises(AppError) as caught:
        await require_identity(request(**{
            "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
        }))
    assert caught.value.status_code == 401


async def test_local_auth_is_explicitly_development_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    development = Settings(_env_file=None, app_env="test", auth_mode="local")
    monkeypatch.setattr(auth, "get_settings", lambda: development)
    assert (await require_identity(request())).subject == "local-development"
    # Even a corrupted/bypassed Settings construction cannot open production.
    development.app_env = "production"
    with pytest.raises(AppError):
        await require_identity(request())


def production(**overrides: Any) -> Settings:
    values = {
        "_env_file": None, "app_env": "production", "auth_mode": "cloudflare",
        "frontend_origin": "https://photos.example.invalid",
        "api_origin": "https://photos.example.invalid",
        "database_url": "postgresql+asyncpg://private:strong@database/catalog",
        "access_team_domain": "unit.cloudflareaccess.com",
        "access_audience": "unit-audience",
        "access_allowed_emails": ["owner@example.invalid"],
        "storage_backend": "r2", "storage_endpoint": "https://unit.r2.cloudflarestorage.com",
        "storage_access_key": "unit-key", "storage_secret_key": "unit-secret",
        "bridge_token_pepper": "p" * 32,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.mark.parametrize("changes", [
    {"auth_mode": "local"}, {"access_allowed_emails": []},
    {"access_team_domain": "unit.cloudflareaccess.com.evil.invalid"},
    {"frontend_origin": "http://photos.example.invalid"},
    {"api_origin": "http://photos.example.invalid"}, {"storage_backend": "local"},
    {"storage_endpoint": "http://unit.r2.cloudflarestorage.com"},
    {"bridge_token_pepper": "short"}, {"cors_origins": ["*"]},
    {"inference_backend": "test"},
    {"database_url": "postgresql+asyncpg://photointel:local-only@database/catalog"},
])
def test_production_configuration_fails_closed(changes: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        production(**changes)


def test_csrf_rejects_foreign_origin_and_missing_cookie_origin() -> None:
    settings = production()
    with pytest.raises(AppError):
        check_origin(request("POST", Origin="https://evil.invalid"), settings)
    with pytest.raises(AppError):
        check_origin(request("PATCH", Cookie="CF_Authorization=sensitive"), settings)
    check_origin(request("POST", Origin=settings.frontend_origin), settings)
    check_origin(request("POST", **{"Cf-Access-Jwt-Assertion": "explicit-jwt"}), settings)


def test_inference_fake_adapter_is_never_a_production_fallback() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="development", inference_backend="test")
    assert Settings(_env_file=None, app_env="test", inference_backend="test").gpu_enabled is False


def test_private_logs_redact_nested_payloads_and_secrets() -> None:
    payload = {
        "error_code": "INFERENCE_FAILED", "token": "secret-value",
        "nested": [{"keywords": ["private"], "bytes": b"image-bytes"}],
        "detail": "provider token=abc123 bearer xyz789",
    }
    redacted = redact_value(payload)
    assert redacted["error_code"] == "INFERENCE_FAILED"
    assert redacted["token"] == "[redacted]"
    assert redacted["nested"][0]["keywords"] == "[redacted]"
    assert "abc123" not in str(redacted)
    assert "xyz789" not in str(redacted)
    assert "image-bytes" not in str(redacted)


async def test_jwks_cache_is_bounded_and_avoids_unknown_key_refresh_storm() -> None:
    import httpx
    import respx

    issuer = "https://cache-unit.cloudflareaccess.com"
    auth._key_cache.pop(issuer, None)
    with respx.mock(assert_all_called=True) as mocked:
        route = mocked.get(f"{issuer}/cdn-cgi/access/certs").mock(
            return_value=httpx.Response(200, json={"keys": [{"kid": "current-key"}]}),
        )
        assert await auth.fetch_keys(issuer, 300) == [{"kid": "current-key"}]
        await auth.fetch_keys(issuer, 300)
        await auth.fetch_keys(issuer, 300, force=True)
        assert route.call_count == 1
    auth._key_cache.pop(issuer, None)


@pytest.mark.parametrize("payload", [[], {"keys": []}, {"keys": ["invalid"]}])
async def test_jwks_malformed_response_fails_closed(payload: Any) -> None:
    import httpx
    import respx

    issuer = "https://malformed-unit.cloudflareaccess.com"
    auth._key_cache.pop(issuer, None)
    with respx.mock(assert_all_called=True) as mocked:
        mocked.get(f"{issuer}/cdn-cgi/access/certs").mock(
            return_value=httpx.Response(200, json=payload),
        )
        with pytest.raises(AppError) as caught:
            await auth.fetch_keys(issuer, 300)
        assert caught.value.status_code == 503
    auth._key_cache.pop(issuer, None)
