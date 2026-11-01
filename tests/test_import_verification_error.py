"""Only new operations above 1,000 assets need explicit release approval."""

from unittest.mock import AsyncMock

import pytest

from photointel.errors import AppError, ErrorCode
from photointel.services import verification


@pytest.mark.asyncio
@pytest.mark.parametrize("count", [1, 10, 100, 1000])
async def test_small_and_bounded_imports_do_not_need_gates(monkeypatch, count):
    status = AsyncMock()
    monkeypatch.setattr(verification, "gate_status", status)

    await verification.require_import_gates(object(), count)
    status.assert_not_awaited()


@pytest.mark.asyncio
async def test_large_import_reports_single_scale_approval_and_setup_action(monkeypatch):
    mock = AsyncMock(return_value={
        "items": [{"id": "F", "status": "not_verified"}]
    })
    monkeypatch.setattr(verification, "gate_status", mock)

    with pytest.raises(AppError) as caught:
        await verification.require_import_gates(object(), 1001)

    exc = caught.value
    assert exc.status_code == 409
    assert exc.code == ErrorCode.VERIFICATION_REQUIRED
    assert exc.details["reason"] == "RELEASE_VERIFICATION_PENDING"
    assert exc.details["required_gates"] == ["F"]
    assert exc.details["gates"] == [{
        "id": "F",
        "name": verification.GATES["F"][0],
        "requirement": verification.GATES["F"][2],
        "status": "not_verified",
    }]
    assert exc.details["action"] == {
        "label": "Autorizar importações grandes", "href": "/setup",
    }


@pytest.mark.asyncio
async def test_large_import_with_scale_approval_passes(monkeypatch):
    monkeypatch.setattr(verification, "gate_status", AsyncMock(return_value={
        "items": [{"id": "F", "status": "passed"}],
    }))
    await verification.require_import_gates(object(), 1001)



@pytest.mark.asyncio
async def test_existing_continuous_authorization_survives_api_redeployment():
    """Saved authorizations must not be revoked merely because API SHA changed."""
    from photointel.config import Settings
    from photointel.services.discovery import _backfill_target
    from photointel.services.import_policy import authorize_import

    settings = Settings(
        _env_file=None,
        app_env="test",
        database_profile="full",
        catalog_asset_limit=2000,
        verification_gates_enforced=True,
    )
    authorization = authorize_import(settings, 100, False)
    persisted = {
        "backfill_authorization": {
            "target_assets": 500,
            "release_sha": "a" * 40,
            "authorized_by": "original-operator",
            "approved_at": "2026-11-01T12:00:00Z",
            "authorization": authorization,
        }
    }
    # No gate check on restart: the initial request carried the approval.
    assert await _backfill_target(None, settings, persisted) == 500

    # Runtime limit reductions still revoke future work in an existing chain.
    reduced = settings.model_copy(update={"catalog_asset_limit": 200})
    with pytest.raises(AppError):
        await _backfill_target(None, reduced, persisted)

    # Invalid/forged metadata never authorizes an unbounded chain.
    invalid = {
        "backfill_authorization": {**persisted["backfill_authorization"],
                                   "authorized_by": ""}
    }
    with pytest.raises(AppError):
        await _backfill_target(None, settings, invalid)
