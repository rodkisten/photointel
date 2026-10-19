"""A device's self-reported write capability never overrides the operator switch."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from photointel.config import Settings
from photointel.errors import AppError
from photointel.routers import bridge


async def test_disabled_native_writes_preserve_claimable_operations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(_env_file=None, app_env="test", apple_native_write_enabled=False)
    monkeypatch.setattr(bridge, "get_settings", lambda: settings)
    session = SimpleNamespace(commit=AsyncMock(), get=AsyncMock())
    device = SimpleNamespace(
        id=uuid4(),
        write_verified=True,
        capabilities={
            "keywords_write": True,
            "keywords_read": True,
        },
    )
    result = await bridge.claim_operations(session, device, 1)
    assert result["items"] == []
    assert result["error_code"] == "PHOTOKIT_WRITE_UNAVAILABLE"
    session.get.assert_not_awaited()
    session.commit.assert_awaited_once()


@pytest.mark.parametrize("enabled,mode", [(False, "manual"), (True, "disabled")])
async def test_disabled_operator_switch_cannot_accept_fabricated_applied_receipt(
    monkeypatch: pytest.MonkeyPatch,
    enabled: bool,
    mode: str,
) -> None:
    settings = Settings(
        _env_file=None,
        app_env="test",
        apple_native_write_enabled=enabled,
        apple_keyword_sync_mode=mode,
    )
    monkeypatch.setattr(bridge, "get_settings", lambda: settings)
    device = SimpleNamespace(
        id=uuid4(),
        write_verified=True,
        capabilities={
            "keywords_write": True,
            "keywords_read": True,
        },
    )
    session = SimpleNamespace(get=AsyncMock(), commit=AsyncMock())
    body = bridge.Acknowledgement(
        status="applied_on_device",
        lease_token="x" * 40,
        before_keywords=["existing"],
        after_keywords=["existing", "new"],
    )
    with pytest.raises(AppError) as error:
        await bridge.acknowledge(uuid4(), body, session, device)
    assert error.value.code == "PHOTOKIT_WRITE_UNAVAILABLE"
    session.get.assert_not_awaited()
    session.commit.assert_not_awaited()
