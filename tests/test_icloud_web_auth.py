"""Browser Apple authentication: encrypted MFA continuation and guarded publishing."""

import base64
from pathlib import Path

import pytest
from pydantic import SecretStr

from photointel.config import Settings
from photointel.errors import AppError
from photointel.services import icloud_web_auth as web


def config(tmp_path: Path) -> Settings:
    return Settings(
        app_env="test",
        icloud_account="fixture@invalid.test",
        icloud_library="PrimarySync",
        icloud_enabled=True,
        icloud_session_backend="encrypted_object",
        icloud_session_key=base64.b64encode(b"k" * 32).decode(),
        icloud_session_directory=tmp_path / "cookies",
    )


def test_readiness_distinguishes_apple_password_and_session_encryption_key(tmp_path):
    cfg = config(tmp_path)
    assert web.login_readiness(cfg)["ready"] is True
    unavailable = cfg.model_copy(update={"icloud_session_key": None})
    status = web.login_readiness(unavailable)
    assert status["ready"] is False
    assert status["code"] == "ICLOUD_SESSION_KEY_UNAVAILABLE"
    assert "senha Apple" in status["message"]
    invalid = cfg.model_copy(update={"icloud_session_key": SecretStr("not-base64")})
    invalid_status = web.login_readiness(invalid)
    assert invalid_status["ready"] is False
    assert invalid_status["code"] == "ICLOUD_SESSION_KEY_INVALID"
    assert "Secret Manager" in invalid_status["message"]
    assert "senha Apple" in invalid_status["message"]


@pytest.mark.asyncio
async def test_short_apple_password_rejected_only_if_infrastructure_missing(monkeypatch, tmp_path):
    cfg = config(tmp_path).model_copy(update={"icloud_session_key": None})
    called = []

    def fake_begin(*args):
        called.append(True)
        raise AssertionError("Apple must not be contacted without the AES session key")

    monkeypatch.setattr(web, "_begin_sync", fake_begin)
    with pytest.raises(AppError, match="chave técnica"):
        await web.start_login(cfg, "admin@invalid.test", "shortpass")
    assert not called


def test_browser_challenge_is_encrypted_short_lived_and_identity_bound(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    source = tmp_path / "stage"
    source.mkdir()
    (source / "session").write_bytes(b"very-private-apple-cookie")
    monkeypatch.setattr(web.time, "time", lambda: 1000)
    encrypted = web.seal_pending(cfg, "admin@invalid.test", source, "2fa")
    assert "very-private-apple-cookie" not in encrypted
    assert "admin@invalid.test" not in encrypted
    snapshot, mode = web.open_pending(cfg, "admin@invalid.test", encrypted)
    assert mode == "2fa"
    assert b"very-private-apple-cookie" in snapshot

    for person in ("another@invalid.test", "Admin+other@invalid.test"):
        with pytest.raises(AppError):
            web.open_pending(cfg, person, encrypted)
    for challenge in ("", encrypted[:-8] + "AAAAAAAA", "not-base64!"):
        with pytest.raises(AppError):
            web.open_pending(cfg, "admin@invalid.test", challenge)

    monkeypatch.setattr(web.time, "time", lambda: 1601)
    with pytest.raises(AppError, match="expirado"):
        web.open_pending(cfg, "admin@invalid.test", encrypted)


@pytest.mark.asyncio
async def test_web_password_start_uses_staged_challenge_without_publishing(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    called = []

    def fake_begin(configuration, email, password):
        called.append(("begin", email, password))
        return {
            "state": "verification_required",
            "mode": "2fa",
            "challenge": "encrypted",
            "expires_in": 600,
            "message": "MFA",
        }

    async def forbidden_publish(*args):
        raise AssertionError("Must not publish before MFA")

    monkeypatch.setattr(web, "_begin_sync", fake_begin)
    monkeypatch.setattr(web, "_publish", forbidden_publish)
    result = await web.start_login(cfg, "admin@invalid.test", "secret-123")
    assert result["state"] == "verification_required"
    assert called == [("begin", "admin@invalid.test", "secret-123")]


@pytest.mark.asyncio
async def test_web_mfa_requires_six_digits_and_validated_apple_session(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    called = []

    def fake_finish(configuration, email, challenge, code):
        called.append(("verify", challenge, code))
        return {"state": "authenticated", "archive": b"fixture", "libraries": ["PrimarySync"]}

    async def fake_publish(configuration, result):
        called.append(("publish",))
        return {"state": "connected", "valid": True, "session_published": True}

    monkeypatch.setattr(web, "_finish_sync", fake_finish)
    monkeypatch.setattr(web, "_publish", fake_publish)
    for code in ("", "12345", "12AB56", "1234567"):
        with pytest.raises(AppError, match="6 dígitos"):
            await web.verify_login(cfg, "admin@invalid.test", "opaque", code)
    assert not called
    result = await web.verify_login(cfg, "admin@invalid.test", "opaque", "123456")
    assert result["state"] == "connected"
    assert called == [("verify", "opaque", "123456"), ("publish",)]


@pytest.mark.asyncio
async def test_password_never_published_when_library_access_fails(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    with pytest.raises(AppError, match="biblioteca"):
        await web._publish(cfg, {"libraries": ["NotTheConfiguredLibrary"], "archive": b"fixture"})


@pytest.mark.asyncio
async def test_begin_rejects_missing_configuration_before_contacting_apple(tmp_path):
    cfg = config(tmp_path).model_copy(update={"icloud_account": ""})
    with pytest.raises(AppError, match="Configure"):
        await web.start_login(cfg, "admin@invalid.test", "password")
